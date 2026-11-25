/**
 * A reply whose only content is that it is not replying.
 *
 * The follow rules ask for a truly empty reply when there is nothing to add,
 * and the model still sometimes writes the decision down instead: "(empty
 * reply - nothing to add here)" landed in a channel thread as a real message.
 * A prompt rule the model can ignore is not a guarantee, so the boundary drops
 * these too. Kept deliberately narrow - short, and nothing but a silence
 * phrase - so a real answer that happens to mention one is never swallowed.
 *
 * Two more shapes are dropped. A reply that ENDS in a NO_REPLY line is the
 * sentinel with narration in front of it, at any length: the last word is the
 * decision. And a short note that only narrates a react-only turn ("I added a
 * reaction and posted no reply", "reacted, staying quiet") is the model
 * describing its own decision, which is a message about whether to message.
 */
const SILENCE =
  /^(?:empty reply|no[_ ]reply(?: needed| required)?|no response(?: needed| required)?|nothing (?:to add|further|more to add)|staying (?:quiet|silent)|silence|(?:a )?reaction is enough|not for me)\b/;

/** A trailing NO_REPLY line, with or without a summary written before it. */
const TRAILING_NO_REPLY = /(?:^|\n|[.!?:]\s)[\s`*_~"'(]*no[_ ]reply[\s`*_~"').!]*$/i;

/** True when the reply is the NO_REPLY sentinel, alone or as the last line after some narration. */
export const endsInNoReply = (text: string): boolean => TRAILING_NO_REPLY.test(text.trim());

/** How a note about reacting starts: "reacted", "just reacting", "I added a reaction"... */
const REACT_LEAD =
  /^(?:i(?:'ve| have)? )?(?:just |only |simply )?(?:reacted|reacting|(?:added|left|put|dropped|gave|sent|used) (?:a |an |the |my |some )?(?:\S+ )?(?:reaction|emoji|reacji)s?)\b/;

/** Words allowed after that start for the note to be nothing but "...and I said nothing". */
const NARRATION_WORDS = new Set(
  `a an the and but so i did didnt do not no nothing only just here there it this that reply replied response message text needed required necessary
  posted post sent send wrote add added further more else to for staying stay quiet silent silence instead enough is was will be with of other separate
  written words any say said one on`.split(/\s+/),
);

/** A reaction clause followed by nothing but silence words: the bot narrating a react-only turn. */
const narratesReactOnly = (bare: string): boolean => {
  const lead = REACT_LEAD.exec(bare);
  if (!lead) return false;
  const rest = bare
    .slice(lead[0].length)
    .replace(/[\u2019']/g, "")
    .split(/[\s,;:()\-\u2013\u2014]+/)
    // emoji and :name: shortcodes carry no words
    .filter((w) => /[a-z]/.test(w) && !/^:[\w+-]+:$/.test(w));
  return rest.every((w) => NARRATION_WORDS.has(w));
};

/** Longest note still treated as a placeholder rather than an answer. */
export const MAX_SILENCE_NOTE = 80;

export const isSilenceNote = (text: string): boolean => {
  const t = text.trim();
  if (!t) return false;
  if (endsInNoReply(t)) return true;
  if (t.length > MAX_SILENCE_NOTE) return false;
  const bare = t
    .replace(/^[\s([_*~`"']+|[\s)\]_*~`"'.!]+$/g, "")
    .toLowerCase();
  return SILENCE.test(bare) || narratesReactOnly(bare);
};
