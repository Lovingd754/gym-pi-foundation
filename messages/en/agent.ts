export const agent = {
  title: 'Coach',
  subtitle: 'Ask about today’s training, food, sleep or your plan.',
  newChat: 'New chat',
  quickLog: 'Quick log',
  recent: 'Recent',
  empty: {
    title: 'Start the conversation',
    body: 'Tell me how you slept, what you ate, or what you cannot train tomorrow. I look at your plan first, then answer.',
    hint: 'Tool results are kept as short summaries, and long threads are compressed automatically.',
  },
  composer: {
    placeholder: 'Message the coach…',
    send: 'Send',
    stop: 'Stop',
  },
  tool: {
    running: 'Reading',
    done: 'Done',
    failed: 'Failed',
    blocked: 'Not allowed',
    names: {
      get_current_plan: 'current plan',
      get_recent_training: 'recent training',
      get_memories: 'remembered notes',
      propose_memory: 'a note to remember',
      propose_plan_change: 'a plan change to review',
      log_workout: 'a set to record',
    },
  },
  notices: {
    compressed: 'Earlier messages were summarized. The original text stays in your history.',
  },
  intent: {
    label: 'Read as',
    log: 'Logging a set',
    plan: 'Changing the plan',
    review: 'Looking something up',
    general: 'General',
  },
  stopReasons: {
    completed: '',
    cancelled: 'You stopped this reply.',
    timeout: 'This reply took too long and was stopped.',
    'model-limit': 'This reply needed too many steps and was stopped.',
    'tool-limit': 'This reply asked for data too many times and was stopped.',
    'safety-stop': 'A blocked action ended this reply.',
    error: 'Something went wrong. Please try again.',
  },
  model: {
    label: 'Model',
    demo: 'Demo mode: replies come from a built-in script, not a live model.',
  },
  // Phrasing for tool summaries. The model paraphrases these back to the
  // trainee, so they follow the interface language and avoid raw enum values
  // and jargon (no RIR, no TDEE, no "deload").
  plan: {
    noPlan:
      'No active personalized plan yet. This trainee still needs to finish the body-and-goal assessment.',
    header: 'Plan: {status} · v{version}{activated}',
    activated: ' · active since {date}',
    goal: 'Goal: {goal} · about {rate}% bodyweight change per week',
    focus: '{weekday} focus: {what}',
    strength:
      'Strength ({split}): {days} days a week · {sets} sets per muscle group per week · about {minutes} min per session',
    exercise: '{sets} × {reps} · {rir} reps left in reserve',
    exerciseNoRir: '{sets} × {reps}',
    cardio: 'Cardio: {minutes} min a week in total',
    cardioNone: 'Cardio: nothing extra needed',
    nutrition:
      'Food per day: {calories} kcal · protein {protein} g · carbs {carbs} g · fat {fat} g',
    meal: '{name}: {calories} kcal · protein {protein} g · carbs {carbs} g · fat {fat} g',
    sleep: 'Sleep: {target} a night · lights out about {bedtime}, up at {wake}',
    sleepTransition: 'For the next two weeks, build from {from} to {to}',
    rest: 'rest',
    hours: '{h} h',
    hoursMinutes: '{h} h {m} min',
    minutes: '{m} min',
    hoursRange: '{min}–{max} h',
  },
  training: {
    header: 'Last {count} finished sessions (newest first)',
    empty: 'No finished sessions are recorded in the app yet.',
    session: '{date} · {name}{duration} · {exercises} exercises',
    cardioSession: '{date} · {name}{duration}',
    cardio: 'Cardio {duration}{distance}',
    distance: ' · {km} km',
    topSet: '{name}: {sets} sets, heaviest {weight} kg × {reps}',
    topSetBodyweight: '{name}: {sets} sets, heaviest {reps} bodyweight reps',
    setsOnly: '{name}: {sets} sets',
    unstructured: 'Training',
  },
  memory: {
    header: 'Notes this trainee confirmed keeping ({count})',
    empty: 'Nothing is remembered about this trainee yet.',
    more: 'Older notes are not shown.',
    proposed:
      'The note is now waiting for the trainee to accept or decline. It is NOT saved yet: say that you proposed it and that they decide, never that you remembered it.',
    alreadyKept:
      'This is already one of the trainee’s confirmed notes. Do not propose it again; you may simply use it.',
    alreadyPending:
      'An identical note is already waiting for the trainee to accept or decline. Do not propose it again.',
    card: {
      title: 'Remember this?',
      accept: 'Remember',
      dismiss: 'Don’t remember',
      accepted: 'Kept. It will be used in later conversations.',
      dismissed: 'Dropped. It will not be remembered.',
      failed: 'Could not update that note.',
    },
    settings: {
      title: 'What the coach remembers',
      description:
        'Notes you accepted in the chat. The coach reads them in every later conversation; delete anything that no longer applies.',
      empty: 'Nothing yet. Accept a note in the chat and it shows up here.',
      delete: 'Delete',
      deleted: 'Note deleted.',
      failed: 'Could not delete that note.',
    },
  },
  change: {
    exerciseRow: '{weekday} · {day}',
    trainingDayRow: 'Training day',
    cardioRow: 'Cardio per week',
    noPlan: 'There is no active personalized plan to change yet.',
    proposed:
      'The change is now waiting for the trainee to confirm. It is NOT applied yet: say that you proposed it and that they decide, never that the plan has changed.',
    card: {
      title: 'Change your plan?',
      apply: 'Apply change',
      dismiss: 'Not now',
      applied: 'Plan updated.',
      dismissed: 'Change dropped.',
      stale: 'Your plan changed since this was proposed. Ask again and I will redo it.',
      failed: 'Could not apply that change.',
    },
  },
  log: {
    exerciseRow: 'Movement',
    volumeRow: 'Each set',
    volume: '{weight} {unit} × {reps}',
    setsRow: 'Sets',
    rirRow: 'Effort',
    rir: '{rir} reps left in reserve',
    prepared:
      'The entry is ready for the trainee to confirm. It is NOT saved yet: say that you prepared it, never that it is recorded.',
    unknownExercise:
      'That movement is not in the trainee’s catalog yet, so nothing was prepared. Ask them to add it in the exercise catalog, or use a movement they already have.',
    card: {
      title: 'Log this?',
      apply: 'Log it',
      dismiss: 'Don’t log',
      applied: 'Logged. It is in your history.',
      dismissed: 'Dropped.',
      failed: 'Could not log that set.',
    },
  },
};
