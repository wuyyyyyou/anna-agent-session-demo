// These buttons fill the form. They never create a session or start a run.
export const TUTORIAL_PROMPTS = Object.freeze({
  context: {
    content: "I'm building a reading list app for frontend developers. Remember these details and confirm in one sentence.",
  },
  followup: {
    content: "Who is the app for? Suggest three features they would find useful.",
  },
  style: {
    content: "Write a one-line description of the app.",
    systemPrompt: "For this turn, write a playful tagline. Return only the tagline.",
  },
  default: {
    content: "Describe the app again in one sentence.",
  },
  search: {
    content: "Use web_search to find the MDN documentation for JavaScript async iterators. Explain the idea briefly and include the source URL. If search returns no results, say so.",
  },
  long: {
    content: "Write a detailed guide to JavaScript async iterators, with several complete code examples and exercises.",
    systemPrompt: "For this turn, give a thorough explanation with examples.",
  },
});
