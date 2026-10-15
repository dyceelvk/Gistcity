/**
 * Dialogue system: talking to NPCs and to other players.
 *
 * Every conversation offers the player real choices; each choice carries what
 * the player says and how the other side answers. NPC replies come from the
 * persona scripts below; replies from other players come back over the realtime
 * channel (see `cloud.say`) so both humans can respond to each other.
 *
 * Conversations grant small social rewards (popularity / xp) and city tips —
 * they are the "interactions that respond" of GistCity life.
 */

export interface DialogueChoice {
  icon: string;
  label: string;
  /** What my character says when I pick this. */
  say: string;
  /** How an NPC answers (players answer for themselves). */
  response: string;
  effect?: { popularity?: number; xp?: number; tip?: string };
  /** Second round after this exchange (NPC conversations only). */
  then?: DialogueRound;
  /** True when picking this ends the conversation after the line is spoken. */
  close?: boolean;
}

export interface DialogueRound {
  /** The other side's line shown above the choices. */
  line?: string;
  choices: DialogueChoice[];
}

export interface Conversation {
  name: string;
  role: string;
  opening: string;
  choices: DialogueChoice[];
}

/** Free-form quick replies for player ↔ player chat (each side picks its own). */
export const QUICK_REPLIES = [
  { icon: '👋', label: 'How far?', say: 'How far?' },
  { icon: '😊', label: 'I dey fine, you?', say: 'I dey fine, you?' },
  { icon: '🤝', label: 'Make we plan together', say: 'Make we plan together — wetin you get for mind?' },
  { icon: '💼', label: 'You dey work?', say: 'You dey work? I dey find partner for business.' },
  { icon: '❤️', label: 'I like your vibe', say: 'I like your vibe — make we talk well well.' },
  { icon: '🚶', label: 'Make we go somewhere', say: 'Make we go somewhere quiet talk.' },
] as const;

const bye: DialogueChoice = {
  icon: '🚶', label: 'Alright, make we talk later', say: 'Alright, make we talk later.',
  response: 'No wahala. Take care!', close: true,
};

/* --------------------------------------------------------------- NPC scripts */

type Persona = { role: string; opening: string; round1: DialogueChoice[] };

const PERSONAS: Record<string, Persona> = {
  trader: {
    role: 'Market trader',
    opening: 'Welcome, welcome! You dey buy or you dey ask?',
    round1: [
      {
        icon: '🛒', label: 'What you get today?', say: 'Wetin you get today?',
        response: 'Rice, beans, pepper, oil — everything fresh. And market dey move today o!',
        effect: { tip: 'Tip: market hustles pay more when you complete them fast.' },
        then: {
          line: 'You wan start small business? I fit teach you how to price.',
          choices: [
            { icon: '💡', label: 'Teach me', say: 'Abeg teach me how to price.', response: 'Buy cheap, sell small-small profit, never sell on credit. Na so we dey do am.', effect: { popularity: 1, xp: 5 } },
            { icon: '🙏', label: 'Maybe later', say: 'Maybe later, ma.', response: 'No wahala. The market no dey run go anywhere.', effect: { popularity: 1 } },
          ],
        },
      },
      {
        icon: '😋', label: 'You get food?', say: 'You get food? Hunger dey catch me.',
        response: 'Suya spot dey burst today — go there, tell am Mama Bisi send you.',
        effect: { tip: 'Tip: eating keeps your hunger up — low hunger slows your walking.' },
      },
      bye,
    ],
  },
  street: {
    role: 'Area youth',
    opening: 'Area! How far? Wetin dey sup for this side?',
    round1: [
      {
        icon: '🗣️', label: 'Wetin dey happen for town?', say: 'Wetin dey happen for town?',
        response: 'Omo, gist plenty. Odogwu Motors get new cars, and the Secretariat dey hire people wey get certificate.',
        effect: { tip: 'Tip: Unity College certificates open government jobs.' },
        then: {
          line: 'You go school before? Certificate dey change level for this city.',
          choices: [
            { icon: '🎓', label: 'I go enrol', say: 'Make I go enrol for Unity College.', response: 'Na the correct move! Driving licence first if you wan drive.', effect: { popularity: 1, xp: 5 } },
            { icon: '🤷', label: 'School no be my level', say: 'School no be my level.', response: 'Hustle still dey — POS, dispatch, market runs. Just no give up.', effect: { popularity: 1 } },
          ],
        },
      },
      {
        icon: '⚽', label: 'Who dey win for pitch?', say: 'Who dey win for pitch?',
        response: 'My team dey win since morning o! Come try penalty shootout — na 5k side bet.', effect: { popularity: 1, xp: 3 },
      },
      {
        icon: '🤝', label: 'Introduce yourself', say: 'My name dey the badge — I new for area.',
        response: 'Welcome to GistCity! Person wey greet, person wey go chop. Make yourself at home.', effect: { popularity: 2, xp: 5 },
      },
      bye,
    ],
  },
  official: {
    role: 'Government worker',
    opening: 'Good day. This is the city information desk — how may I help?',
    round1: [
      {
        icon: '📋', label: 'How I fit get work?', say: 'How I fit get government work?',
        response: 'Enrol at Unity College, get your certificate, then apply at the Employment desk inside the Secretariat. Ten steps, queue for everybody.',
        effect: { tip: 'Tip: government shifts pay from the Payroll account every shift.' },
      },
      {
        icon: '🏠', label: 'House and property?', say: 'How property dey work for this city?',
        response: 'Property registry dey come soon. For now, your flat dey Gist Heights — furnish am well.',
        effect: { tip: 'Tip: age and wealth will decide who can own what when the registry opens.' },
      },
      {
        icon: '💍', label: 'Marriage registry?', say: 'Marriage and family registry don ready?',
        response: 'The Civil Registry dey open for registrations. Two people must agree together — no force, no shortcut.',
        effect: { tip: 'Tip: marriage needs consent from both citizens, and a marriage agreement.' },
      },
      bye,
    ],
  },
  faithful: {
    role: 'Church member',
    opening: 'God bless you! You don visit Grace Chapel before?',
    round1: [
      {
        icon: '⛪', label: 'About the church', say: 'Wetin dey happen for Grace Chapel?',
        response: 'Services dey live sometimes — reserve your seat inside so the usher know. Offering na voluntary.',
        effect: { tip: 'Tip: church attendance gives reputation; offerings go to the church account.' },
      },
      {
        icon: '🙏', label: 'Pray for me', say: 'Abeg, pray for me.',
        response: 'It is well with you! Work go come, money go come, and your name go shine.', effect: { popularity: 1, xp: 5 },
      },
      bye,
    ],
  },
  mechanic: {
    role: 'Mechanic',
    opening: 'Oga! Your car get problem or you dey look for car?',
    round1: [
      {
        icon: '🔧', label: 'About cars', say: 'Wetin I need know about cars for this city?',
        response: 'First get your licence for Unity College. Then Odogwu Motors go sell to you. No licence, no car — na so the law dey.',
        effect: { tip: 'Tip: you can share your car keys with friends from the garage panel.' },
      },
      {
        icon: '🚗', label: 'Which car dey last?', say: 'Which car dey last well well?',
        response: 'Toks Corolla na correct workhorse. Venza soft. Odogwu G-630 na statement — but fuel of that one na for big boys.', effect: { popularity: 1, xp: 3 },
      },
      bye,
    ],
  },
};

const GENERIC: Persona = {
  role: 'Citizen',
  opening: 'Hey! How you dey?',
  round1: [
    {
      icon: '👋', label: 'Greet properly', say: 'Good afternoon! How you dey?',
      response: 'I dey o! Welcome to GistCity. Person wey dey friendly, na so doors dey open for am.',
      effect: { popularity: 1, xp: 3 },
    },
    {
      icon: '💡', label: 'Ask for advice', say: 'Abeg, any advice for person wey new?',
      response: 'Hustle small-small, eat well, rest well, and find people wey get the same dream with you. Na so we dey build am.',
      effect: { tip: 'Tip: needs affect your speed — eat, drink and sleep to stay sharp.' },
    },
    bye,
  ],
};

/** Pick the persona for an NPC by name (deterministic, so they stay in character). */
export function npcConversation(name: string): Conversation {
  const keys = Object.keys(PERSONAS);
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const p = PERSONAS[keys[h % keys.length]];
  return { name, role: p.role, opening: p.opening, choices: p.round1 };
}

/** A player ↔ player conversation: choices are what *I* say; the human on the other side replies. */
export function citizenConversation(name: string, firstLine?: string): Conversation {
  return {
    name,
    role: 'Citizen',
    opening: firstLine ? `“${firstLine}”` : `You walk up to ${name}. What do you say?`,
    choices: [
      ...QUICK_REPLIES.map((q) => ({
        icon: q.icon, label: q.label, say: q.say,
        response: '', // real players answer for themselves
      })),
      { icon: '🚶', label: 'End the conversation', say: 'I dey go — see you around!', response: '', close: true },
    ],
  };
}
