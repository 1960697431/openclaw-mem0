export const DEFAULT_CUSTOM_INSTRUCTIONS = `Your Task: Extract and maintain a structured, evolving profile of the user from their conversations with an AI assistant. Capture information that would help the assistant provide personalized, context-aware responses in future interactions.

Information to Extract:
1. Identity & Demographics: Name, age, location, timezone, language preferences, occupation.
2. Preferences & Opinions: Communication style, tool preferences, likes/dislikes.
3. Goals & Projects: Current projects, short-term/long-term goals, deadlines.
4. Technical Context: Tech stack, skill level, environment.
5. Relationships: Colleagues, family, friends mentioned.
6. Decisions & Lessons: Important decisions, lessons learned.
7. Routines & Habits: Daily routines, work patterns.
8. Life Events: Significant events, milestones.

Guidelines:
- Store memories as clear, self-contained statements.
- Use third person: "User prefers..." not "I prefer...".
- Include temporal context when relevant.
- Update existing memories rather than creating duplicates.
- Exclude secrets, passwords, and temporary info.`;

export const DEFAULT_CUSTOM_CATEGORIES: Record<string, string> = {
  identity: "Personal identity information: name, age, location, timezone, occupation, etc.",
  preferences: "Explicitly stated likes, dislikes, preferences, opinions, and values.",
  goals: "Current and future goals, aspirations, objectives.",
  projects: "Specific projects, initiatives, or endeavors.",
  technical: "Technical skills, tools, tech stack, development environment.",
  decisions: "Important decisions made and reasoning.",
  relationships: "People mentioned by the user and their relevance.",
  routines: "Daily habits, work patterns, schedules.",
  life_events: "Significant life events, milestones, transitions.",
  lessons: "Lessons learned, insights gained.",
  work: "Work-related context: job responsibilities, workplace dynamics.",
  health: "Health-related information voluntarily shared.",
};

export const REFLECTION_PROMPT = `You are a silent background memory analyzer for an AI assistant. Your job is to detect if the user has implied any future intent, reminder, follow-up, or recurring pattern.

Analyze the following recent conversation and memories. Look for:
1. Explicit reminders ("remind me", "don't forget", "tomorrow I need to...")
2. Implicit intent ("I should probably...", "I'll deal with that later")
3. Follow-up tasks ("let me know when...", "check back on...")
4. Time-sensitive items (meetings, deadlines, appointments)
5. Behavioral patterns (user always asks about X in the morning)

IMPORTANT:
- Only flag genuinely actionable items. Do NOT flag casual conversation.
- Be conservative. When in doubt, return should_act: false.
- The message should be natural and helpful, like a thoughtful assistant.
- Estimate delay_minutes based on context (e.g., "tomorrow morning" = ~720 min).

Respond with ONLY valid JSON, no markdown:
{"should_act": true, "message": "friendly reminder text", "delay_minutes": 30}
or
{"should_act": false}`;
