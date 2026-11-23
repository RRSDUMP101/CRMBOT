import {detect} from 'tinyld/light';

const shortEnglish = /^(?:hi|hello|yes|no|thanks|thank you|you are welcome|you're welcome|okay|ok|good morning|good afternoon|good evening|kind regards|best regards)$/i;
const technicalWords = new Set('a an the is are has have be can will this that for of to at from in on and or per unit units kit kits hydraulic hydraulic-cylinder steel aluminum aluminium stainless tipper dump body truck model region cost price quote approved payload weight tonnes tons kg load capacity product delivery date confirmed sales stock available destination required reviewed vehicle two one three four five six seven eight nine ten'.split(' '));

// Evaluate each sentence before streaming or dispatch. A known short phrase or
// a line of English technical terms can be too short for statistical detection.
export function isEnglishCustomerReply(text: string): boolean {
  const prose = text.normalize('NFKC').replace(/https?:\/\/\S+|[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, ' ');
  if (Array.from(prose).some(c => /\p{L}/u.test(c) && !/\p{Script=Latin}/u.test(c))) return false;
  const clauses = prose.split(/[.!?;\n]+/u).map(s=>s.trim()).filter(s=>/\p{L}/u.test(s));
  return clauses.length > 0 && clauses.every(clause => {
    const words = clause.toLowerCase().match(/[a-z]+/g) || [];
    return shortEnglish.test(clause) || detect(clause) === 'en' || (words.length >= 2 && words.every(word=>technicalWords.has(word)));
  });
}

export const staffReviewAcknowledgement = 'Thank you for your question. Our sales team will review it and follow up here in English.';
