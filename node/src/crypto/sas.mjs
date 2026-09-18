/**
 * Short Authentication String.
 *
 * The rendezvous server introduces two peers who have never met. It could just
 * as easily introduce a peer to *itself* and sit in the middle. DTLS does not
 * help — the server would simply terminate two DTLS sessions.
 *
 * The defence is the one ZRTP uses: derive a short string from the Noise
 * transcript hash and have the humans compare it out of band ("read me the
 * four words"). A machine in the middle runs two different handshakes, so it
 * gets two different transcripts and cannot make both strings match without
 * a 2^32 online search — one guess per connection attempt, with a human
 * watching.
 */

import crypto from 'node:crypto';

/**
 * 256 short, common, phonetically distinct English words.
 * Index = one byte, so four words carry exactly 32 bits.
 */
export const WORDLIST = (
  'acid actor add adult afraid agent air alarm album alert alien alpha ' +
  'amber anchor angle ankle apple april arch arctic arena argue armor arrow ' +
  'art ash atlas atom aunt autumn axis bacon badge bagel baker balloon ' +
  'bamboo banjo barley basil basket batch beach beacon beard beaver bench berry ' +
  'bicycle binary birch bishop bison black blade blanket blue board bonus boot ' +
  'boss bottle boxer brain branch brave bread brick bridge broom brown brush ' +
  'bubble bucket buffalo bugle builder bullet bundle bunker burger cabin cable cactus ' +
  'camel candle canvas canyon carbon cargo carpet carrot castle cedar celery cement ' +
  'census chalk charm cheese cherry chess chief chili chimney cinema circus citrus ' +
  'civil clay clever cliff clock cloud clover cobra cocoa coffee comet compass ' +
  'copper coral cotton cougar county cousin cowboy coyote crane crater crayon cricket ' +
  'crown crystal cuckoo cupcake curry cymbal dagger dairy dancer dawn deck deer ' +
  'delta denim dentist desert diamond diesel dinner dolphin domino donkey dragon drum ' +
  'duck dune eagle early earth echo eclipse edge eight elbow elder electric ' +
  'elephant elm ember emerald empire energy engine equal eraser escape ethics europe ' +
  'event exit fabric falcon fancy farmer feather fern ferry fiber fiction fifty ' +
  'figure filter finger fire fish flag flame flask flint float flower flute ' +
  'focus forest forge fossil fountain fox frame friend frost fuel garden garlic ' +
  'gasoline gate gecko gentle ginger giraffe glacier glass globe glove goblin golden ' +
  'gopher gorilla granite grape gravel green grill guitar gumbo gypsum hammer hamster ' +
  'harbor harvest hazel helmet heron hickory hidden honey hornet horse hotel hunter ' +
  'ice iron island ivory'
).trim().split(/\s+/);

if (WORDLIST.length !== 256) {
  throw new Error(`SAS wordlist must hold exactly 256 words, found ${WORDLIST.length}`);
}

const SAS_INFO = Buffer.from('penguin-stream sas v1', 'utf8');

/**
 * @param {Buffer} handshakeHash transcript hash from HandshakeState.handshakeHash
 * @param {number} words how many words to emit (4 => 32 bits)
 * @returns {{words: string[], phrase: string, bits: number}}
 */
export function deriveSAS(handshakeHash, words = 4) {
  if (!Buffer.isBuffer(handshakeHash) || handshakeHash.length !== 32) {
    throw new Error('handshakeHash must be a 32-byte Buffer');
  }
  if (!Number.isInteger(words) || words < 2 || words > 8) {
    throw new Error('words must be an integer in [2, 8]');
  }
  const out = Buffer.from(
    crypto.hkdfSync('sha256', handshakeHash, Buffer.alloc(32), SAS_INFO, words),
  );
  const picked = [...out].map((b) => WORDLIST[b]);
  return { words: picked, phrase: picked.join(' '), bits: words * 8 };
}

/** Constant-time comparison so a remote peer cannot time its way to a match. */
export function sasEquals(a, b) {
  const ba = Buffer.from(String(a).trim().toLowerCase());
  const bb = Buffer.from(String(b).trim().toLowerCase());
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
