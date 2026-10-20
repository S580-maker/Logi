const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseYouTubeVideoUrl, transcribeAudioFile, transcribeYouTubeVideo } = require('../utils/study-media');

test('YouTube import accepts supported video URL forms', () => {
  assert.equal(
    parseYouTubeVideoUrl('https://youtu.be/dQw4w9WgXcQ?t=30')?.url,
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  );
  assert.equal(
    parseYouTubeVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')?.videoId,
    'dQw4w9WgXcQ'
  );
  assert.equal(
    parseYouTubeVideoUrl('https://youtu.be/dQw4w9WgXcQ?t=30')?.videoId,
    'dQw4w9WgXcQ'
  );
  assert.equal(
    parseYouTubeVideoUrl('https://youtube.com/shorts/dQw4w9WgXcQ')?.videoId,
    'dQw4w9WgXcQ'
  );
});

test('YouTube import rejects non-YouTube, malformed, and insecure URLs', () => {
  assert.equal(parseYouTubeVideoUrl('https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(parseYouTubeVideoUrl('http://youtube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(parseYouTubeVideoUrl('https://youtu.be/not-a-valid-id'), null);
  assert.equal(parseYouTubeVideoUrl('javascript:alert(1)'), null);
});

test('audio transcription sends files to Groq Whisper using the server key', async () => {
  const oldApiKey = process.env.GROQ_API_KEY;
  const oldModel = process.env.GROQ_TRANSCRIPTION_MODEL;
  const oldFetch = global.fetch;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'logi-groq-audio-'));
  const filePath = path.join(directory, 'lecture.webm');
  await fs.writeFile(filePath, Buffer.from('fake audio bytes'));
  process.env.GROQ_API_KEY = 'test-groq-key';
  process.env.GROQ_TRANSCRIPTION_MODEL = 'test-whisper-model';
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ text: 'A test lecture transcript.' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const transcript = await transcribeAudioFile(filePath, 'audio/webm');
    assert.equal(transcript, 'A test lecture transcript.');
    assert.equal(request.url, 'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.equal(request.options.headers.Authorization, 'Bearer test-groq-key');
    assert.equal(request.options.body.get('model'), 'test-whisper-model');
    assert.equal(request.options.body.get('response_format'), 'verbose_json');
    assert.equal(request.options.body.get('file').name, 'lecture.webm');
  } finally {
    global.fetch = oldFetch;
    if (oldApiKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = oldApiKey;
    if (oldModel === undefined) delete process.env.GROQ_TRANSCRIPTION_MODEL;
    else process.env.GROQ_TRANSCRIPTION_MODEL = oldModel;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('YouTube import reads available captions without downloading video audio', async () => {
  const oldFetch = global.fetch;
  const captionUrl = 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en';
  const playerResponse = {
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [{ languageCode: 'en', baseUrl: captionUrl }],
      },
    },
  };
  const requests = [];
  global.fetch = async (url) => {
    requests.push(String(url));
    if (requests.length === 1) {
      return new Response(`ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};`, { status: 200 });
    }
    return new Response(JSON.stringify({
      events: [
        { tStartMs: 0, segs: [{ utf8: 'A captioned lecture.' }] },
        { tStartMs: 5000, segs: [{ utf8: 'It has a second caption.' }] },
      ],
    }), { status: 200 });
  };
  try {
    const transcript = await transcribeYouTubeVideo('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.match(transcript, /\[00:00:00\] A captioned lecture\./);
    assert.match(transcript, /\[00:00:05\] It has a second caption\./);
    assert.equal(requests.length, 2);
    assert.match(requests[1], /fmt=json3/);
  } finally {
    global.fetch = oldFetch;
  }
});
