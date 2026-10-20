const assert = require('node:assert/strict');
const test = require('node:test');
const { askGroq, askPersonalGroq, getStudyModeInstruction } = require('../utils/notebook-ai');

test('study modes give distinct, bounded learning guidance', () => {
  const explain = getStudyModeInstruction('explain');
  const recap = getStudyModeInstruction('recap');
  const quiz = getStudyModeInstruction('quiz');

  assert.match(explain, /reasoning in manageable steps/i);
  assert.match(recap, /concise revision recap/i);
  assert.match(quiz, /one question at a time/i);
  assert.match(quiz, /without revealing its answer/i);
  assert.notEqual(explain, recap);
  assert.notEqual(recap, quiz);
});

test('unknown study modes safely use the explain guidance', () => {
  assert.equal(getStudyModeInstruction('unsupported'), getStudyModeInstruction('explain'));
});

test('personal AI answers without requiring course sources and continues chat history', async () => {
  const oldApiKey = process.env.GROQ_API_KEY;
  const oldFetch = global.fetch;
  process.env.GROQ_API_KEY = 'test-groq-key';
  let request;
  global.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ answer: 'Here is a general answer.' }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const result = await askPersonalGroq({
      question: 'Can you explain this another way?',
      history: [
        { role: 'user', text: 'What is gravity?' },
        { role: 'assistant', text: 'Gravity is an attractive force.' },
      ],
    });
    assert.equal(request.url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(request.body.messages[0].role, 'system');
    assert.match(request.body.messages[0].content, /personal AI assistant/i);
    assert.equal(request.body.messages[1].content, 'What is gravity?');
    assert.equal(request.body.messages[2].role, 'assistant');
    assert.match(request.body.messages.at(-1).content, /Can you explain this another way/);
    assert.equal(request.body.max_tokens, 1800);
    assert.equal(result.answer, 'Here is a general answer.');
  } finally {
    global.fetch = oldFetch;
    if (oldApiKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = oldApiKey;
  }
});

test('Groq notebook answers use the server API key and verify source citations', async () => {
  const oldApiKey = process.env.GROQ_API_KEY;
  const oldModel = process.env.GROQ_MODEL;
  const oldFetch = global.fetch;
  process.env.GROQ_API_KEY = 'test-groq-key';
  process.env.GROQ_MODEL = 'test-chat-model';
  let request;
  global.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            answer: 'The source explains the central concept.',
            citations: [{
              sourceId: 4,
              page: 2,
              quote: 'The central concept connects energy with cellular respiration.',
            }],
          }),
        },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const result = await askGroq({
      sources: [{
        id: 4,
        original_name: 'Biology.pdf',
        pages: [{
          page: 2,
          text: 'The central concept connects energy with cellular respiration.',
        }],
      }],
      question: 'Explain the concept.',
      history: [{ role: 'model', text: 'What subject is this?' }],
    });
    assert.equal(request.url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(request.options.headers.Authorization, 'Bearer test-groq-key');
    assert.equal(request.body.model, 'test-chat-model');
    assert.deepEqual(request.body.response_format, { type: 'json_object' });
    assert.equal(request.body.messages[1].role, 'assistant');
    assert.equal(result.model, 'test-chat-model');
    assert.equal(result.citations.length, 1);
    assert.equal(result.citations[0].fileName, 'Biology.pdf');
  } finally {
    global.fetch = oldFetch;
    if (oldApiKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = oldApiKey;
    if (oldModel === undefined) delete process.env.GROQ_MODEL;
    else process.env.GROQ_MODEL = oldModel;
  }
});

test('Groq returns an answer without a citation when no quote can be verified', async () => {
  const oldApiKey = process.env.GROQ_API_KEY;
  const oldFetch = global.fetch;
  process.env.GROQ_API_KEY = 'test-groq-key';
  let requestCount = 0;

  try {
    global.fetch = async () => {
      requestCount += 1;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              answer: 'Force is described in the selected material.',
              citations: [{ sourceId: 99, page: 1, quote: 'This passage is not in a selected source.' }],
            }),
          },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const result = await askGroq({
      sources: [{ id: 8, original_name: 'Physics.txt', pages: [{ page: 1, text: 'The source contains different words entirely.' }] }],
      question: 'What is force?',
    });
    assert.equal(result.answer, 'Force is described in the selected material.');
    assert.deepEqual(result.citations, []);
    assert.equal(requestCount, 1);
  } finally {
    global.fetch = oldFetch;
    if (oldApiKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = oldApiKey;
  }
});
