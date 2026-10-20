const assert = require('node:assert/strict');
const test = require('node:test');
const { parseStudySet } = require('../utils/study-set');

const validStudySet = {
  notes: ['A useful central idea.', 'A second important relationship.', 'A third key distinction.'],
  flashcards: Array.from({ length: 6 }, (_, index) => ({
    front: `Question ${index + 1}: what is this concept?`,
    back: `The concise explanation for concept ${index + 1}.`,
  })),
  quiz: Array.from({ length: 5 }, (_, index) => ({
    question: `Which statement correctly explains concept ${index + 1}?`,
    options: ['First answer', 'Second answer', 'Third answer', 'Fourth answer'],
    answerIndex: index % 4,
    explanation: `The correct concept is explained by option ${index % 4 + 1}.`,
  })),
};

test('study set parser accepts a complete, bounded study set', () => {
  assert.deepEqual(parseStudySet(JSON.stringify(validStudySet)), validStudySet);
});

test('study set parser rejects malformed or incomplete AI output', () => {
  assert.throws(() => parseStudySet('not JSON'), /readable format/);
  assert.throws(() => parseStudySet(JSON.stringify({
    ...validStudySet,
    quiz: [{ ...validStudySet.quiz[0], answerIndex: 4 }, ...validStudySet.quiz.slice(1)],
  })), /quiz was incomplete/);
  assert.throws(() => parseStudySet(JSON.stringify({
    ...validStudySet,
    flashcards: validStudySet.flashcards.slice(0, 2),
  })), /flashcards were incomplete/);
});
