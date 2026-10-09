const path = require('path');

const topicStopWords = new Set([
  'about', 'after', 'again', 'also', 'among', 'and', 'are', 'because', 'been',
  'before', 'being', 'between', 'both', 'but', 'can', 'could', 'does', 'each',
  'for', 'from', 'has', 'have', 'how', 'into', 'its', 'may', 'more', 'most',
  'not', 'one', 'other', 'our', 'out', 'over', 'same', 'should', 'some', 'such',
  'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
  'those', 'through', 'two', 'use', 'used', 'using', 'very', 'was', 'were',
  'what', 'when', 'where', 'which', 'while', 'will', 'with', 'within', 'would',
  'you', 'your', 'figure', 'table', 'chapter', 'slide', 'page',
  'course', 'department', 'university', 'level', 'title', 'template', 'outline',
  'information', 'technology', 'students', 'student', 'lecture', 'learning',
  'assessment', 'grade', 'grades', 'marks', 'mark', 'lecturer', 'academic',
  'semester', 'session', 'phone', 'number', 'email', 'assignment', 'quiz',
  'midterm', 'final', 'coursework', 'examination', 'class', 'contact',
]);

function getContentTopics(text, fileName) {
  const fileWords = path.basename(fileName, path.extname(fileName)).toLowerCase().match(/[a-z]{3,}/g) || [];
  const genericTopicWords = new Set([
    'computer', 'system', 'systems', 'data', 'model', 'models', 'content', 'topic',
    ...fileWords,
  ]);
  const words = text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];
  const frequencies = new Map();
  const phrases = new Map();
  let previousWord = '';
  for (const word of words) {
    if (topicStopWords.has(word) || /^\d+$/.test(word)) {
      previousWord = '';
      continue;
    }
    if (!genericTopicWords.has(word)) frequencies.set(word, (frequencies.get(word) || 0) + 1);
    if (previousWord) {
      const phrase = `${previousWord} ${word}`;
      phrases.set(phrase, (phrases.get(phrase) || 0) + 1);
    }
    previousWord = word;
  }
  const rankedTopics = [
    ...[...frequencies.entries()]
      .filter(([, count]) => count >= 2)
      .map(([topic, count]) => [topic, count]),
    ...[...phrases.entries()].map(([topic, count]) => [topic, count * 4 + 4]),
  ];
  return rankedTopics
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6)
    .map(([topic]) => topic);
}

function getEvidenceForTopic(pages, topic) {
  const escapedTopic = topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const page of pages) {
    const excerpts = page.text.split(/[\r\n]+|(?<=[.!?])\s+/);
    const sentence = excerpts.find((item) => new RegExp(`\\b${escapedTopic}\\b`, 'i').test(item));
    if (sentence) {
      const safeText = sentence
        .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, '[email]')
        .replace(/\+?[\d(][\d\s()./-]{7,}\d/g, (number) =>
          (number.match(/\d/g) || []).length >= 9 ? '[phone number]' : number
        );
      const topicIndex = safeText.toLowerCase().indexOf(topic.toLowerCase());
      const start = Math.max(0, topicIndex - 70);
      const end = Math.min(safeText.length, topicIndex + topic.length + 110);
      const excerpt = `${start > 0 ? '...' : ''}${safeText.slice(start, end).trim()}${end < safeText.length ? '...' : ''}`;
      return {
        excerpt,
        page: page.page,
      };
    }
  }
  return null;
}

function buildContentSuggestions(contentItems) {
  const suggestions = [];
  const sources = [];
  for (const item of contentItems) {
    const topics = getContentTopics(item.text, item.original_name);
    const primaryTopic = topics[0];
    if (!primaryTopic) continue;
    const evidence = getEvidenceForTopic(item.pages, primaryTopic);
    if (!evidence) continue;

    const title = path.basename(item.original_name, path.extname(item.original_name));
    const secondaryTopic = topics.find((topic) => topic !== primaryTopic);
    sources.push({ slideId: Number(item.id), fileName: item.original_name, pageCount: item.pages.length });
    suggestions.push({
      title: item.is_completed ? `Recall: ${primaryTopic}` : `Understand: ${primaryTopic}`,
      detail: item.is_completed
        ? `Explain "${primaryTopic}" from memory, then check your explanation against the source.`
        : `This file repeatedly discusses "${primaryTopic}". Explain the idea in your own words and connect it to a concrete example.`,
      reason: `Found in ${title}${evidence.page ? `, page ${evidence.page}` : ''}${secondaryTopic ? `; another recurring term is "${secondaryTopic}".` : '.'}`,
      evidence: evidence.excerpt,
      practicePrompt: `Using only what you remember, explain "${primaryTopic}" and how it relates to: "${evidence.excerpt}". Then check the source and correct any gaps.`,
      mode: item.is_completed ? 'review' : 'practice',
      privateNote: item.note || '',
      courseId: Number(item.course_id),
      slideId: Number(item.id),
      fileName: item.original_name,
      page: evidence.page,
      topics,
    });
    if (suggestions.length >= 3) break;
  }
  return { suggestions, sources };
}

module.exports = { buildContentSuggestions };
