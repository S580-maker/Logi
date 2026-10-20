const STUDY_SET_SCHEMA = {
  notes: { min: 3, max: 6, length: 700 },
  flashcards: { min: 6, max: 12, length: 500 },
  quiz: { min: 5, max: 8, length: 500 },
};

function boundedText(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength
    ? value.trim()
    : null;
}

function parseStudySet(answer) {
  let parsed;
  try {
    parsed = JSON.parse(answer);
  } catch {
    throw new Error('The study set was not returned in a readable format. Please try again.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The study set was incomplete. Please try again.');
  }

  const notes = Array.isArray(parsed.notes)
    ? parsed.notes.map((note) => boundedText(note, STUDY_SET_SCHEMA.notes.length))
    : [];
  const flashcards = Array.isArray(parsed.flashcards)
    ? parsed.flashcards.map((card) => ({
      front: boundedText(card?.front, 180),
      back: boundedText(card?.back, STUDY_SET_SCHEMA.flashcards.length),
    }))
    : [];
  const quiz = Array.isArray(parsed.quiz)
    ? parsed.quiz.map((question) => ({
      question: boundedText(question?.question, 300),
      options: Array.isArray(question?.options)
        ? question.options.map((option) => boundedText(option, 180))
        : [],
      answerIndex: question?.answerIndex,
      explanation: boundedText(question?.explanation, STUDY_SET_SCHEMA.quiz.length),
    }))
    : [];

  if (notes.length < STUDY_SET_SCHEMA.notes.min || notes.length > STUDY_SET_SCHEMA.notes.max ||
      notes.some((note) => !note)) {
    throw new Error('The study notes were incomplete. Please generate the study set again.');
  }
  if (flashcards.length < STUDY_SET_SCHEMA.flashcards.min ||
      flashcards.length > STUDY_SET_SCHEMA.flashcards.max ||
      flashcards.some((card) => !card.front || !card.back)) {
    throw new Error('The flashcards were incomplete. Please generate the study set again.');
  }
  if (quiz.length < STUDY_SET_SCHEMA.quiz.min || quiz.length > STUDY_SET_SCHEMA.quiz.max ||
      quiz.some((question) =>
        !question.question || !question.explanation ||
        question.options.length !== 4 || question.options.some((option) => !option) ||
        new Set(question.options).size !== question.options.length ||
        !Number.isInteger(question.answerIndex) ||
        question.answerIndex < 0 || question.answerIndex > 3
      )) {
    throw new Error('The quiz was incomplete. Please generate the study set again.');
  }

  return { notes, flashcards, quiz };
}

module.exports = { parseStudySet };
