const fs = require('fs');
const path = require('path');

const MAX_TRANSCRIPT_CHARS = 24000;
const MAX_YOUTUBE_PAGE_BYTES = 8 * 1024 * 1024;
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const DEFAULT_TRANSCRIPTION_MODEL = 'whisper-large-v3-turbo';
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

function createMediaError(message, status, retryable = status >= 500) {
  const error = new Error(message);
  error.status = status;
  error.retryable = retryable;
  return error;
}

function parseYouTubeVideoUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let videoId = '';
  if (host === 'youtu.be') {
    videoId = url.pathname.slice(1).split('/')[0];
  } else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') videoId = url.searchParams.get('v') || '';
    else videoId = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1] || '';
  }
  return YOUTUBE_VIDEO_ID.test(videoId)
    ? { url: `https://www.youtube.com/watch?v=${videoId}`, videoId }
    : null;
}

function getTranscriptText(text) {
  const transcript = typeof text === 'string' ? text.trim() : '';
  if (!transcript) {
    throw createMediaError('The transcription service returned no speech. Check that the recording has audible speech.', 422, false);
  }
  if (transcript.length <= MAX_TRANSCRIPT_CHARS) return transcript;
  const marker = '\n[Transcript truncated at the 24,000-character study-source limit.]';
  return `${transcript.slice(0, MAX_TRANSCRIPT_CHARS - marker.length)}${marker}`;
}

function getGroqError(status, message) {
  if (status === 401 || status === 403) {
    return createMediaError('Groq rejected the API key. Check GROQ_API_KEY in .env and restart LogiAuth.', 503, false);
  }
  if (status === 400 || status === 404) {
    return createMediaError('Groq rejected the transcription request. Check that the audio format and GROQ_TRANSCRIPTION_MODEL are supported.', 422, false);
  }
  if (status === 413) return createMediaError('The audio file is too large for Groq transcription.', 413, false);
  if (status === 429) return createMediaError('Groq is temporarily rate-limited. Wait a moment and try again.', 429);
  if (status === 503) return createMediaError('Groq is temporarily busy. Please try again shortly.', 503);
  console.error('Groq transcription failed:', String(message || 'Unknown provider error').slice(0, 300));
  return createMediaError('Could not reach Groq transcription. Check your connection and try again.', 502);
}

async function transcribeAudioFile(filePath, mimeType) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw createMediaError('Transcription is not configured. Add GROQ_API_KEY to .env and restart the app.', 503, false);
  }

  let bytes;
  try {
    bytes = await fs.promises.readFile(filePath);
  } catch (error) {
    console.error('Could not read audio file for Groq transcription:', error.message);
    throw createMediaError('Could not read the uploaded audio file.', 500);
  }
  if (!bytes.length) throw createMediaError('The audio file is empty.', 422, false);

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mimeType || 'application/octet-stream' }), path.basename(filePath));
  form.append('model', process.env.GROQ_TRANSCRIPTION_MODEL || DEFAULT_TRANSCRIPTION_MODEL);
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');

  let response;
  try {
    response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(180000),
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw createMediaError('Groq transcription took too long. Please try again.', 504);
    }
    console.error('Could not reach Groq transcription:', error.message.slice(0, 300));
    throw createMediaError('Could not reach Groq transcription. Check your connection and try again.', 502);
  }

  let result;
  try {
    result = await response.json();
  } catch {
    result = null;
  }
  if (!response.ok) {
    throw getGroqError(response.status, result?.error?.message);
  }
  return getTranscriptText(result?.text);
}

function extractJsonObject(text, start) {
  const objectStart = text.indexOf('{', start);
  if (objectStart < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = objectStart; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(objectStart, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function formatYouTubeCaptionEvents(events) {
  return events
    .filter((event) => Array.isArray(event.segs))
    .map((event) => {
      const text = event.segs.map((segment) => segment.utf8 || '').join('').trim();
      if (!text) return '';
      const seconds = Math.floor(Number(event.tStartMs || 0) / 1000);
      const timestamp = new Date(seconds * 1000).toISOString().slice(11, 19);
      return `[${timestamp}] ${text}`;
    })
    .filter(Boolean)
    .join('\n');
}

async function fetchBoundedResponse(url, timeoutMs, maxBytes) {
  let target = new URL(url);
  let response;
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    if (target.protocol !== 'https:' || !YOUTUBE_HOSTS.has(target.hostname)) {
      throw createMediaError('Could not read this YouTube resource.', 422, false);
    }
    response = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LogiAuth/1.0)' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    if (!location || redirects === 4) {
      throw createMediaError('YouTube redirected too many times.', 422, false);
    }
    target = new URL(location, target);
  }
  if (!response.ok) throw createMediaError('Could not read this public YouTube video.', 422, false);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw createMediaError('The YouTube captions response is too large to process.', 413, false);
  }
  const reader = response.body?.getReader();
  if (!reader) return { response, buffer: Buffer.alloc(0) };
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw createMediaError('The YouTube captions response is too large to process.', 413, false);
    }
    chunks.push(Buffer.from(value));
  }
  return { response, buffer: Buffer.concat(chunks, totalBytes) };
}

async function transcribeYouTubeVideo(url) {
  const video = parseYouTubeVideoUrl(url);
  if (!video) throw createMediaError('Enter a valid HTTPS YouTube video link.', 400, false);

  let page;
  try {
    const fetched = await fetchBoundedResponse(video.url, 15000, MAX_YOUTUBE_PAGE_BYTES);
    page = fetched.buffer.toString('utf8');
  } catch (error) {
    if (error.status) throw error;
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw createMediaError('YouTube took too long to respond. Please try again.', 504);
    }
    console.error('Could not load YouTube page for captions:', error.message.slice(0, 300));
    throw createMediaError('Could not read this public YouTube video. Upload its audio if captions are unavailable.', 422, false);
  }

  const marker = page.match(/ytInitialPlayerResponse\s*=\s*/);
  const player = marker
    ? extractJsonObject(page, marker.index + marker[0].length)
    : null;
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || !tracks.length) {
    throw createMediaError('This video has no available captions. Upload an audio recording of the video for Groq transcription.', 422, false);
  }

  const track = tracks.find((item) => item.languageCode?.toLowerCase().startsWith('en')) || tracks[0];
  let captionUrl;
  try {
    captionUrl = new URL(track.baseUrl);
  } catch {
    throw createMediaError('Could not read captions for this YouTube video.', 422, false);
  }
  if (captionUrl.protocol !== 'https:' ||
      !YOUTUBE_HOSTS.has(captionUrl.hostname) ||
      captionUrl.pathname !== '/api/timedtext') {
    throw createMediaError('Could not read captions for this YouTube video.', 422, false);
  }
  captionUrl.searchParams.set('fmt', 'json3');

  try {
    const { buffer } = await fetchBoundedResponse(captionUrl, 15000, MAX_YOUTUBE_PAGE_BYTES);
    let captions;
    try {
      captions = JSON.parse(buffer.toString('utf8'));
    } catch {
      throw createMediaError('YouTube returned unreadable captions. Upload the audio file for transcription instead.', 422, false);
    }
    return getTranscriptText(formatYouTubeCaptionEvents(captions.events || []));
  } catch (error) {
    if (error.status) throw error;
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw createMediaError('YouTube captions took too long to load. Please try again.', 504);
    }
    console.error('Could not fetch YouTube captions:', error.message.slice(0, 300));
    throw createMediaError('Could not read captions for this YouTube video. Upload its audio for Groq transcription.', 422, false);
  }
}

module.exports = {
  MAX_TRANSCRIPT_CHARS,
  parseYouTubeVideoUrl,
  transcribeAudioFile,
  transcribeYouTubeVideo,
};
