/**
 * Inline mini-benchmark suite (SWE-bench-shaped).
 *
 * These tasks run WITHOUT Docker using the pure-JS scorer in
 * lib/benchmark-scorer.js. Each task specifies:
 *   - prompt:   natural language instruction for the agent
 *   - entry:    the exported function name the scorer should call
 *   - testCases: list of { input: [args...], expected: value }
 *
 * Difficulty tags (not enforced, used for reporting):
 *   easy    — single-step logic, no edge cases
 *   medium  — multi-step logic or common algorithm
 *   tricky  — deliberately includes off-by-one / edge-case traps
 */

/** @type {import("../benchmark-harness.js").BenchmarkTask[]} */
export const MINI_TASKS = [
  {
    id: "mini-001",
    title: "Sum of evens",
    difficulty: "easy",
    language: "javascript",
    entry: "sumEvens",
    prompt: "Write a function `sumEvens(arr)` that returns the sum of all even numbers in an array. Export it as a named export: `export function sumEvens(arr) { ... }`.",
    testCases: [
      { input: [[1, 2, 3, 4, 5]], expected: 6 },
      { input: [[]], expected: 0 },
      { input: [[2, 4, 6]], expected: 12 },
      { input: [[1, 3, 5]], expected: 0 },
      { input: [[-2, -4, 1]], expected: -6 },
    ],
  },
  {
    id: "mini-002",
    title: "FizzBuzz value",
    difficulty: "easy",
    language: "javascript",
    entry: "fizzbuzz",
    prompt: "Write a function `fizzbuzz(n)` that returns 'FizzBuzz' if n is divisible by 15, 'Fizz' if divisible by 3, 'Buzz' if divisible by 5, otherwise the number as a string. Export as named export `fizzbuzz`.",
    testCases: [
      { input: [15], expected: "FizzBuzz" },
      { input: [9], expected: "Fizz" },
      { input: [10], expected: "Buzz" },
      { input: [7], expected: "7" },
      { input: [0], expected: "FizzBuzz" },
      { input: [30], expected: "FizzBuzz" },
    ],
  },
  {
    id: "mini-003",
    title: "Reverse string",
    difficulty: "easy",
    language: "javascript",
    entry: "reverseString",
    prompt: "Write a function `reverseString(s)` that returns the reverse of the given string. Export as named export.",
    testCases: [
      { input: ["hello"], expected: "olleh" },
      { input: [""], expected: "" },
      { input: ["a"], expected: "a" },
      { input: ["ab"], expected: "ba" },
      { input: ["racecar"], expected: "racecar" },
    ],
  },
  {
    id: "mini-004",
    title: "Is palindrome (case-insensitive, alphanumeric only)",
    difficulty: "tricky",
    language: "javascript",
    entry: "isPalindrome",
    prompt: "Write a function `isPalindrome(s)` that returns true iff s reads the same forward and backward, considering ONLY alphanumeric characters and ignoring case. Export as named export.",
    testCases: [
      { input: ["A man, a plan, a canal: Panama"], expected: true },
      { input: ["race a car"], expected: false },
      { input: [""], expected: true },
      { input: [".,"], expected: true },
      { input: ["0P"], expected: false },
      { input: ["Ab2Ba"], expected: true },
      { input: ["ab1cd"], expected: false },
    ],
  },
  {
    id: "mini-005",
    title: "Two sum",
    difficulty: "medium",
    language: "javascript",
    entry: "twoSum",
    prompt: "Write a function `twoSum(nums, target)` that returns a 2-element array of indices [i, j] (i < j) such that nums[i] + nums[j] === target. Exactly one valid pair is guaranteed. Export as named export.",
    testCases: [
      { input: [[2, 7, 11, 15], 9], expected: [0, 1] },
      { input: [[3, 2, 4], 6], expected: [1, 2] },
      { input: [[3, 3], 6], expected: [0, 1] },
      { input: [[1, 5, 3, 7], 10], expected: [2, 3] },
    ],
  },
  {
    id: "mini-006",
    title: "Merge sorted arrays",
    difficulty: "medium",
    language: "javascript",
    entry: "mergeSorted",
    prompt: "Write a function `mergeSorted(a, b)` that takes two already-sorted (ascending) arrays of numbers and returns a single sorted merged array containing all elements. Export as named export.",
    testCases: [
      { input: [[1, 3, 5], [2, 4, 6]], expected: [1, 2, 3, 4, 5, 6] },
      { input: [[], []], expected: [] },
      { input: [[1, 2, 3], []], expected: [1, 2, 3] },
      { input: [[], [4, 5]], expected: [4, 5] },
      { input: [[1, 1, 2], [1, 3]], expected: [1, 1, 1, 2, 3] },
    ],
  },
  {
    id: "mini-007",
    title: "Deep clone",
    difficulty: "tricky",
    language: "javascript",
    entry: "deepClone",
    prompt: "Write a function `deepClone(value)` that returns a deep copy of the given JSON-compatible value (supports nested objects and arrays). The clone must not share any object references with the original. Export as named export.",
    testCases: [
      { input: [{ a: 1, b: { c: 2 } }], expected: { a: 1, b: { c: 2 } } },
      { input: [[1, [2, [3]]]], expected: [1, [2, [3]]] },
      { input: [null], expected: null },
      { input: [42], expected: 42 },
      { input: ["hi"], expected: "hi" },
      { input: [[]], expected: [] },
    ],
  },
  {
    id: "mini-008",
    title: "Binary search",
    difficulty: "medium",
    language: "javascript",
    entry: "binarySearch",
    prompt: "Write a function `binarySearch(arr, target)` that returns the index of target in the sorted array arr, or -1 if not found. Export as named export.",
    testCases: [
      { input: [[1, 3, 5, 7, 9], 5], expected: 2 },
      { input: [[1, 3, 5, 7, 9], 1], expected: 0 },
      { input: [[1, 3, 5, 7, 9], 9], expected: 4 },
      { input: [[1, 3, 5, 7, 9], 4], expected: -1 },
      { input: [[], 5], expected: -1 },
      { input: [[2], 2], expected: 0 },
      { input: [[2], 3], expected: -1 },
    ],
  },
  {
    id: "mini-009",
    title: "Count vowels",
    difficulty: "easy",
    language: "javascript",
    entry: "countVowels",
    prompt: "Write a function `countVowels(s)` that returns the number of vowels (a, e, i, o, u, case-insensitive) in s. Export as named export.",
    testCases: [
      { input: ["hello"], expected: 2 },
      { input: ["HELLO"], expected: 2 },
      { input: [""], expected: 0 },
      { input: ["xyz"], expected: 0 },
      { input: ["aeiouAEIOU"], expected: 10 },
    ],
  },
  {
    id: "mini-010",
    title: "Flatten one level",
    difficulty: "medium",
    language: "javascript",
    entry: "flattenOnce",
    prompt: "Write a function `flattenOnce(arr)` that flattens the given array by exactly one level. Non-array elements are preserved as-is. Export as named export.",
    testCases: [
      { input: [[1, [2, 3], 4]], expected: [1, 2, 3, 4] },
      { input: [[[1], [2], [3]]], expected: [1, 2, 3] },
      { input: [[]], expected: [] },
      { input: [[[[1, 2]], 3]], expected: [[1, 2], 3] },
      { input: [[1, 2, 3]], expected: [1, 2, 3] },
    ],
  },
];

/**
 * Fetch a named suite.
 * @param {string} name
 * @returns {import("../benchmark-harness.js").BenchmarkTask[]}
 */
export function getSuite(name) {
  switch (name) {
    case "mini":
    case "mini-tasks":
      return MINI_TASKS;
    default:
      throw new Error(`unknown suite: ${name}`);
  }
}
