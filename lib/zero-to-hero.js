/**
 * Interactive "Zero to Hero" LLM curriculum based on Karpathy's lectures.
 * Track user progress through lessons, exercises, and projects.
 *
 * Storage: data/zero-to-hero/{userId}/progress.json
 *          data/zero-to-hero/workspaces/{workspaceId}/leaderboard.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

function getDataDir() {
  return process.env.STORAGE_PATH || join(process.cwd(), "data");
}

function sanitize(val, fallback) {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function getProgressFilePath(userId) {
  const uid = sanitize(userId, "anonymous");
  return join(getDataDir(), "zero-to-hero", "users", uid, "progress.json");
}

function getLeaderboardDir(workspaceId) {
  const ws = sanitize(workspaceId, "default");
  return join(getDataDir(), "zero-to-hero", "workspaces", ws);
}

function loadProgress(userId) {
  const file = getProgressFilePath(userId);
  try {
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, "utf8"));
    }
  } catch {
    // corrupted -> reset
  }
  return null;
}

function saveProgress(userId, data) {
  const file = getProgressFilePath(userId);
  ensureDir(file);
  writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function defaultProgress(userId) {
  return {
    userId,
    startedAt: new Date().toISOString(),
    currentLessonId: CURRICULUM.lessons[0].id,
    completedLessons: [],
    exerciseResults: {},
    badges: [],
    totalHours: 0,
  };
}

export const CURRICULUM = {
  title: "Neural Networks: Zero to Hero",
  author: "Andrej Karpathy",
  description:
    "Build your understanding of neural networks, language models, and transformers from scratch.",
  lessons: [
    {
      id: "micrograd",
      order: 1,
      title: "Micrograd: Building a tiny autograd engine",
      description:
        "Build backpropagation from scratch. The spelled-out intro to neural networks and backpropagation.",
      karpathyVideo: "https://www.youtube.com/watch?v=VMj-3S1tku0",
      topics: ["gradient descent", "backprop", "chain rule", "computational graph"],
      prerequisites: [],
      exercises: [
        { id: "value-class", difficulty: "easy" },
        { id: "manual-backprop", difficulty: "medium" },
        { id: "mlp-from-scratch", difficulty: "hard" },
      ],
      estimatedHours: 3,
    },
    {
      id: "makemore-bigram",
      order: 2,
      title: "Makemore: Bigram language model",
      description: "Character-level language models, sampling, evaluation.",
      karpathyVideo: "https://www.youtube.com/watch?v=PaCmpygFfXo",
      topics: ["probability", "bigrams", "sampling", "cross-entropy loss"],
      prerequisites: ["micrograd"],
      exercises: [
        { id: "bigram-counts", difficulty: "easy" },
        { id: "bigram-nn", difficulty: "medium" },
      ],
      estimatedHours: 2,
    },
    {
      id: "makemore-mlp",
      order: 3,
      title: "Makemore: MLP language model",
      description: "Multilayer perceptron for language modeling.",
      karpathyVideo: "https://www.youtube.com/watch?v=TCH_1BHY58I",
      topics: ["embeddings", "MLP", "train/val split", "hyperparameters"],
      prerequisites: ["makemore-bigram"],
      exercises: [{ id: "mlp-lm", difficulty: "medium" }],
      estimatedHours: 3,
    },
    {
      id: "makemore-activations",
      order: 4,
      title: "Makemore: Activations, gradients, BatchNorm",
      description: "Deep into neural network internals.",
      karpathyVideo: "https://www.youtube.com/watch?v=P6sfmUTpUmc",
      topics: ["activations", "gradients", "batch norm", "kaiming init"],
      prerequisites: ["makemore-mlp"],
      exercises: [],
      estimatedHours: 3,
    },
    {
      id: "makemore-backprop",
      order: 5,
      title: "Makemore: Manual backprop through cross-entropy, BatchNorm",
      description: "Understanding gradients by implementing them by hand.",
      karpathyVideo: "https://www.youtube.com/watch?v=q8SA3rM6ckI",
      topics: ["manual backprop", "cross-entropy", "batch norm backward"],
      prerequisites: ["makemore-activations"],
      exercises: [],
      estimatedHours: 3,
    },
    {
      id: "makemore-wavenet",
      order: 6,
      title: "Makemore: Becoming a backprop ninja (WaveNet)",
      description: "Hierarchical models, torch internals.",
      karpathyVideo: "https://www.youtube.com/watch?v=t3YJ5hKiMQ0",
      topics: ["WaveNet", "dilated convolutions", "torch internals"],
      prerequisites: ["makemore-backprop"],
      exercises: [],
      estimatedHours: 2,
    },
    {
      id: "nano-gpt",
      order: 7,
      title: "nanoGPT: Building GPT from scratch",
      description:
        "Let's build GPT. Self-attention, transformers, from scratch in code, step by step.",
      karpathyVideo: "https://www.youtube.com/watch?v=kCc8FmEb1nY",
      topics: [
        "self-attention",
        "transformer",
        "positional encoding",
        "multi-head",
        "residual connections",
      ],
      prerequisites: ["makemore-wavenet"],
      exercises: [
        { id: "self-attention", difficulty: "hard" },
        { id: "transformer-block", difficulty: "hard" },
      ],
      estimatedHours: 4,
    },
    {
      id: "tokenizer",
      order: 8,
      title: "Let's build the GPT Tokenizer",
      description: "BPE tokenization from scratch.",
      karpathyVideo: "https://www.youtube.com/watch?v=zduSFxRajkE",
      topics: ["BPE", "tokenization", "unicode", "regex splitting"],
      prerequisites: ["nano-gpt"],
      exercises: [{ id: "bpe-encoder", difficulty: "medium" }],
      estimatedHours: 3,
    },
    {
      id: "reproducing-gpt2",
      order: 9,
      title: "Let's reproduce GPT-2",
      description: "Train GPT-2 from scratch using llm.c and PyTorch.",
      karpathyVideo: "https://www.youtube.com/watch?v=l8pRSuU81PU",
      topics: ["training at scale", "mixed precision", "distributed training", "llm.c"],
      prerequisites: ["tokenizer"],
      exercises: [],
      estimatedHours: 8,
    },
  ],
};

export const BADGES = {
  first_steps: {
    id: "first_steps",
    name: "First Steps",
    criteria: "Complete first lesson",
    icon: "star",
  },
  backprop_master: {
    id: "backprop_master",
    name: "Backprop Master",
    criteria: "Complete micrograd",
    icon: "brain",
  },
  language_modeler: {
    id: "language_modeler",
    name: "Language Modeler",
    criteria: "Complete all makemore lessons",
    icon: "book",
  },
  gpt_builder: {
    id: "gpt_builder",
    name: "GPT Builder",
    criteria: "Build nanoGPT from scratch",
    icon: "rocket",
  },
  tokenizer_wizard: {
    id: "tokenizer_wizard",
    name: "Tokenizer Wizard",
    criteria: "Build BPE tokenizer",
    icon: "wand",
  },
  zero_to_hero: {
    id: "zero_to_hero",
    name: "Zero to Hero",
    criteria: "Complete entire curriculum",
    icon: "trophy",
  },
};

const MAKEMORE_LESSON_IDS = [
  "makemore-bigram",
  "makemore-mlp",
  "makemore-activations",
  "makemore-backprop",
  "makemore-wavenet",
];

function getLessonById(lessonId) {
  return CURRICULUM.lessons.find((l) => l.id === lessonId);
}

function prerequisitesMet(lesson, completedLessons) {
  if (!lesson || !lesson.prerequisites || lesson.prerequisites.length === 0) return true;
  return lesson.prerequisites.every((p) => completedLessons.includes(p));
}

/**
 * Start the curriculum for a user. Initializes progress if needed.
 */
export async function startCurriculum(userId, workspaceId) {
  const uid = sanitize(userId, "anonymous");
  let progress = loadProgress(uid);
  if (!progress) {
    progress = defaultProgress(uid);
    progress.workspaceId = sanitize(workspaceId, "default");
    saveProgress(uid, progress);
  }
  return {
    started: true,
    userId: uid,
    currentLessonId: progress.currentLessonId,
    completedLessons: progress.completedLessons,
  };
}

/**
 * Get a user's current progress. Returns a default if none exists.
 */
export async function getUserProgress(userId) {
  const uid = sanitize(userId, "anonymous");
  const progress = loadProgress(uid) || defaultProgress(uid);
  const completedCount = progress.completedLessons.length;
  const totalLessons = CURRICULUM.lessons.length;
  const percent = totalLessons > 0 ? Math.round((completedCount / totalLessons) * 100) : 0;
  return {
    userId: uid,
    currentLesson: progress.currentLessonId,
    completedLessons: progress.completedLessons,
    totalHours: progress.totalHours || 0,
    badges: progress.badges || [],
    percentComplete: percent,
    totalLessons,
    completedCount,
    startedAt: progress.startedAt,
  };
}

/**
 * Mark a lesson complete and unlock the next one. Awards badges automatically.
 */
export async function completeLesson(userId, lessonId, completionData = {}) {
  const uid = sanitize(userId, "anonymous");
  const lesson = getLessonById(lessonId);
  if (!lesson) {
    throw new Error(`Unknown lesson: ${lessonId}`);
  }
  let progress = loadProgress(uid) || defaultProgress(uid);

  if (!prerequisitesMet(lesson, progress.completedLessons)) {
    throw new Error(`Prerequisites not met for lesson: ${lessonId}`);
  }

  if (!progress.completedLessons.includes(lessonId)) {
    progress.completedLessons.push(lessonId);
  }
  progress.totalHours =
    (progress.totalHours || 0) +
    (typeof completionData.hoursSpent === "number"
      ? completionData.hoursSpent
      : lesson.estimatedHours || 0);

  // Advance current lesson to the next unlocked one
  const next = CURRICULUM.lessons.find(
    (l) => !progress.completedLessons.includes(l.id) && prerequisitesMet(l, progress.completedLessons),
  );
  progress.currentLessonId = next ? next.id : null;
  progress.lastCompletedAt = new Date().toISOString();

  saveProgress(uid, progress);

  const awarded = [];
  // Badge: first_steps
  if (progress.completedLessons.length >= 1 && !progress.badges.includes("first_steps")) {
    await awardBadge(uid, "first_steps");
    awarded.push("first_steps");
  }
  // Badge: backprop_master
  if (
    progress.completedLessons.includes("micrograd") &&
    !progress.badges.includes("backprop_master")
  ) {
    await awardBadge(uid, "backprop_master");
    awarded.push("backprop_master");
  }
  // Badge: language_modeler — all makemore lessons complete
  if (
    MAKEMORE_LESSON_IDS.every((id) => progress.completedLessons.includes(id)) &&
    !progress.badges.includes("language_modeler")
  ) {
    await awardBadge(uid, "language_modeler");
    awarded.push("language_modeler");
  }
  // Badge: gpt_builder
  if (
    progress.completedLessons.includes("nano-gpt") &&
    !progress.badges.includes("gpt_builder")
  ) {
    await awardBadge(uid, "gpt_builder");
    awarded.push("gpt_builder");
  }
  // Badge: tokenizer_wizard
  if (
    progress.completedLessons.includes("tokenizer") &&
    !progress.badges.includes("tokenizer_wizard")
  ) {
    await awardBadge(uid, "tokenizer_wizard");
    awarded.push("tokenizer_wizard");
  }
  // Badge: zero_to_hero — all lessons complete
  if (
    CURRICULUM.lessons.every((l) => progress.completedLessons.includes(l.id)) &&
    !progress.badges.includes("zero_to_hero")
  ) {
    await awardBadge(uid, "zero_to_hero");
    awarded.push("zero_to_hero");
  }

  // Update workspace leaderboard snapshot
  if (progress.workspaceId) {
    updateLeaderboardEntry(progress.workspaceId, uid, progress);
  }

  return {
    lessonId,
    completed: true,
    nextLessonId: progress.currentLessonId,
    awardedBadges: awarded,
    totalCompleted: progress.completedLessons.length,
  };
}

/**
 * Submit an exercise solution. Delegates grading to karpathy-exercises.js.
 */
export async function submitExercise(userId, exerciseId, solution) {
  const uid = sanitize(userId, "anonymous");
  const { runExercise } = await import("./karpathy-exercises.js");
  const result = runExercise(exerciseId, solution);

  const progress = loadProgress(uid) || defaultProgress(uid);
  progress.exerciseResults = progress.exerciseResults || {};
  const prior = progress.exerciseResults[exerciseId];
  progress.exerciseResults[exerciseId] = {
    passed: result.passed,
    score: result.score,
    feedback: result.feedback,
    attempts: (prior?.attempts || 0) + 1,
    submittedAt: new Date().toISOString(),
  };
  saveProgress(uid, progress);

  return {
    exerciseId,
    passed: result.passed,
    score: result.score,
    feedback: result.feedback,
    errors: result.errors || [],
  };
}

/**
 * Get the current or next unlocked lesson for a user.
 */
export async function getNextLesson(userId) {
  const uid = sanitize(userId, "anonymous");
  const progress = loadProgress(uid) || defaultProgress(uid);
  if (progress.currentLessonId) {
    const lesson = getLessonById(progress.currentLessonId);
    if (lesson) return lesson;
  }
  const next = CURRICULUM.lessons.find(
    (l) => !progress.completedLessons.includes(l.id) && prerequisitesMet(l, progress.completedLessons),
  );
  return next || null;
}

/**
 * Get full lesson content, including exercises.
 */
export async function getLessonContent(lessonId) {
  const lesson = getLessonById(lessonId);
  if (!lesson) return null;
  // Lazy import to avoid cycles
  const { EXERCISES } = await import("./karpathy-exercises.js");
  const exercises = (lesson.exercises || [])
    .map((ex) => {
      const full = EXERCISES[ex.id];
      if (!full) return { ...ex };
      return {
        id: ex.id,
        difficulty: ex.difficulty,
        description: full.description,
        starterCode: full.starterCode,
        hints: full.hints || [],
      };
    })
    .filter(Boolean);
  return { ...lesson, exercises };
}

function updateLeaderboardEntry(workspaceId, userId, progress) {
  const dir = getLeaderboardDir(workspaceId);
  const file = join(dir, "leaderboard.json");
  let data = [];
  try {
    if (existsSync(file)) data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    data = [];
  }
  const idx = data.findIndex((e) => e.userId === userId);
  const entry = {
    userId,
    completedLessons: progress.completedLessons.length,
    badges: (progress.badges || []).length,
    totalHours: progress.totalHours || 0,
    updatedAt: new Date().toISOString(),
  };
  if (idx >= 0) data[idx] = entry;
  else data.push(entry);
  ensureDir(file);
  writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

/**
 * Return the leaderboard for a workspace, sorted by progress.
 */
export async function getLeaderboard(workspaceId) {
  const dir = getLeaderboardDir(workspaceId);
  const file = join(dir, "leaderboard.json");
  let data = [];
  try {
    if (existsSync(file)) data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    data = [];
  }
  data.sort((a, b) => {
    if (b.completedLessons !== a.completedLessons) return b.completedLessons - a.completedLessons;
    if (b.badges !== a.badges) return b.badges - a.badges;
    return b.totalHours - a.totalHours;
  });
  return {
    workspaceId: sanitize(workspaceId, "default"),
    entries: data.map((e, i) => ({ rank: i + 1, ...e })),
  };
}

/**
 * Award a badge to a user.
 */
export async function awardBadge(userId, badgeId) {
  const uid = sanitize(userId, "anonymous");
  if (!BADGES[badgeId]) {
    throw new Error(`Unknown badge: ${badgeId}`);
  }
  const progress = loadProgress(uid) || defaultProgress(uid);
  progress.badges = progress.badges || [];
  if (!progress.badges.includes(badgeId)) {
    progress.badges.push(badgeId);
    progress.badgeAwardedAt = progress.badgeAwardedAt || {};
    progress.badgeAwardedAt[badgeId] = new Date().toISOString();
    saveProgress(uid, progress);
  }
  return { badgeId, awarded: true, badge: BADGES[badgeId] };
}

/**
 * List all badges earned by a user.
 */
export async function getUserBadges(userId) {
  const uid = sanitize(userId, "anonymous");
  const progress = loadProgress(uid) || defaultProgress(uid);
  const earned = (progress.badges || []).map((id) => ({
    ...BADGES[id],
    awardedAt: progress.badgeAwardedAt?.[id] || null,
  }));
  return {
    userId: uid,
    badges: earned,
    available: Object.values(BADGES),
  };
}
