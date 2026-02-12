export const DEFAULT_CUSTOM_INSTRUCTIONS = `Your Task: Extract and maintain a structured, evolving profile of the user and their system state from conversations. Capture information that helps the assistant maintain continuity and AVOID PAST MISTAKES.

CRITICAL: You must capture SYSTEM CONFIGURATIONS, COMPLETED TASKS, and TROUBLESHOOTING SOLUTIONS.

Information to Extract:
1. System State & Config: Installed tools, port numbers, IP addresses, environment variables, server URLs.
2. Task Progress: What has been completed, what is pending, successful milestones.
3. Troubleshooting & Fixes: Specific error messages encountered and the EXACT solution that fixed them. Capture "What works" and "What doesn't".
4. Identity & Demographics: Name, age, location, timezone, language preferences.
5. Preferences & Opinions: Communication style, tool preferences, likes/dislikes.
6. Goals & Projects: Current projects, short-term/long-term goals, deadlines.
7. Technical Context: Tech stack, skill level, environment (OS, hardware).

Guidelines:
- Store memories as clear, self-contained statements.
- Capture specific values (e.g., "BlueBubbles port is 1234") accurately.
- For fixes, format as: "To fix [Error X], do [Solution Y]".
- Use third person: "User's server..." or "System state is...".
- Update existing memories rather than creating duplicates.`;

export const DEFAULT_CUSTOM_CATEGORIES: Record<string, string> = {
  system: "System configurations, environment setup, ports, IPs, installed tools.",
  tasks: "Completed tasks, milestones, progress updates, pending actions.",
  fixes: "Troubleshooting solutions, bug fixes, workarounds, and 'what not to do'.",
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
