/**
 * BotEngine
 *
 * Controls AI bot participants.
 * Strictly adheres to information privacy: bots only use the CURRENTLY REVEALED digits.
 * Implements 9 distinct personalities with private noisy fair-value beliefs so
 * quotes can cross and bot-bot trading occurs naturally.
 *
 * Phase 1: Noisy beliefs with per-bot timers.
 * Phase 2: 4 new personas (SLOW_REACTOR, WRONG_BASE, OVERREACTOR, FORCED_UNWINDER),
 *          duplicate-side prevention, seeded RNG assignment.
 */

const DEFAULT_SIGMA = 0.5;
const BELIEF_TTL_MS = 15_000; // re-draw noise after this long, or on digit reveal
const HIDDEN_DIGIT_DEFAULT = 4.5;
const HIDDEN_DIGIT_WRONG = 5.0;

export class BotEngine {
  static PERSONALITIES = [
    'BOT_FAIR_VALUE',
    'BOT_CONSERVATIVE',
    'BOT_AGGRESSIVE',
    'BOT_MARKET_PLAYER',
    'BOT_RANDOM',
    'SLOW_REACTOR',
    'WRONG_BASE',
    'OVERREACTOR',
    'FORCED_UNWINDER'
  ];

  /** Personalities that must appear at least once in every game. */
  static GUARANTEED = [
    'BOT_FAIR_VALUE',
    'WRONG_BASE',
    'OVERREACTOR',
    'SLOW_REACTOR'
  ];

  /** Pool used for the random remaining slot(s) after guaranteed picks. */
  static REMAINING_POOL = [
    'BOT_FAIR_VALUE',
    'BOT_CONSERVATIVE',
    'BOT_AGGRESSIVE',
    'BOT_MARKET_PLAYER',
    'BOT_RANDOM',
    'FORCED_UNWINDER'
  ];

  static SIGMAS = {
    BOT_FAIR_VALUE:    0.5,
    BOT_CONSERVATIVE:  1.0,
    BOT_AGGRESSIVE:    2.0,
    BOT_MARKET_PLAYER: 1.5,
    BOT_RANDOM:        1.5,  // reduced from 3.0 to limit extreme losses
    SLOW_REACTOR:      1.0,
    WRONG_BASE:        0.5,
    OVERREACTOR:       1.0,
    FORCED_UNWINDER:   0.5
  };

  static MIN_EDGES = {
    BOT_FAIR_VALUE:    0.5,
    BOT_CONSERVATIVE:  1.0,
    BOT_AGGRESSIVE:    0.5,
    BOT_MARKET_PLAYER: 0.5,
    BOT_RANDOM:        0.3,  // was 0.0 — less eager to take crazy trades
    SLOW_REACTOR:      1.0,  // picky, waits for good edge
    WRONG_BASE:        0.5,
    OVERREACTOR:       0.3,  // eager to trade
    FORCED_UNWINDER:   0.5
  };

  static SPREADS = {
    BOT_FAIR_VALUE:    0.5,
    BOT_CONSERVATIVE:  1.5,
    BOT_AGGRESSIVE:    0.5,
    BOT_MARKET_PLAYER: 1.0,
    BOT_RANDOM:        1.5,
    SLOW_REACTOR:      3.0,  // wide quotes
    WRONG_BASE:        1.0,
    OVERREACTOR:       0.5,  // trades near EV
    FORCED_UNWINDER:   1.0
  };

  static QUOTE_PROB = {
    BOT_FAIR_VALUE:    0.6,
    BOT_CONSERVATIVE:  0.4,
    BOT_AGGRESSIVE:    0.8,
    BOT_MARKET_PLAYER: 0.6,
    BOT_RANDOM:        0.5,
    SLOW_REACTOR:      0.4,
    WRONG_BASE:        0.5,
    OVERREACTOR:       0.8,  // trades often
    FORCED_UNWINDER:   0.6
  };

  static CANCEL_PROB = {
    BOT_FAIR_VALUE:    0.2,
    BOT_CONSERVATIVE:  0.15,
    BOT_AGGRESSIVE:    0.4,
    BOT_MARKET_PLAYER: 0.25,
    BOT_RANDOM:        0.3,
    SLOW_REACTOR:      0.6,  // cancels often
    WRONG_BASE:        0.2,
    OVERREACTOR:       0.4,
    FORCED_UNWINDER:   0.2
  };

  /**
   * @param {Object} tradeEngine
   * @param {Object} positionEngine
   * @param {Object} [options]
   * @param {Function} [options.rng] - Seeded RNG returning [0,1). Defaults to Math.random.
   */
  constructor(tradeEngine, positionEngine, options = {}) {
    this.tradeEngine = tradeEngine;
    this.positionEngine = positionEngine;
    this.rng = options.rng || Math.random.bind(Math);

    // Persisted beliefs: Map<playerId, { noisyEV, drawnAt, revealedCount }>
    this.beliefs = new Map();

    // Per-bot runtime state (SLOW_REACTOR delay, etc.)
    this.botStates = new Map();
  }

  // ─── Seeded gaussian noise (Box-Muller) ───────────────────────

  gaussianRandom() {
    let u = 0, v = 0;
    while (u === 0) u = this.rng();
    while (v === 0) v = this.rng();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  // ─── Fair-value helpers ───────────────────────────────────────

  /**
   * The hidden-digit expectation this bot uses.
   * WRONG_BASE always uses 5.0; everyone else uses 4.5.
   */
  hiddenDigitValue(bot) {
    return bot.botType === 'WRONG_BASE' ? HIDDEN_DIGIT_WRONG : HIDDEN_DIGIT_DEFAULT;
  }

  /**
   * Computes the bot's effective fair value (before gaussian noise).
   * Handles WRONG_BASE (different hidden-digit constant) and
   * OVERREACTOR (amplified reaction to each revealed digit).
   */
  getEffectiveFairValue(bot, revealedDigits) {
    const knownSum = revealedDigits.reduce((acc, d) => acc + d, 0);
    const unrevealedCount = 6 - revealedDigits.length;
    const hiddenVal = this.hiddenDigitValue(bot);
    let ev = knownSum + unrevealedCount * hiddenVal;

    if (bot.botType === 'OVERREACTOR') {
      // OVERREACTOR double-counts each revealed digit's deviation from 4.5
      const extra = revealedDigits.reduce((sum, d) => sum + (d - HIDDEN_DIGIT_DEFAULT), 0);
      ev += extra;
    }

    return ev;
  }

  /**
   * Public EV (no personality adjustments) — kept for backward compat / reference.
   */
  getPublicFairValue(revealedDigits) {
    const knownSum = revealedDigits.reduce((acc, d) => acc + d, 0);
    const unrevealedCount = 6 - revealedDigits.length;
    return knownSum + unrevealedCount * HIDDEN_DIGIT_DEFAULT;
  }

  // ─── Noisy EV (persistent belief) ─────────────────────────────

  getNoisyEV(bot, revealedDigits) {
    const now = Date.now();
    const revealedCount = revealedDigits.length;
    const existing = this.beliefs.get(bot.id);

    if (existing) {
      const digitChanged = revealedCount !== existing.revealedCount;
      const expired = now - existing.drawnAt > BELIEF_TTL_MS;
      if (!digitChanged && !expired) {
        return existing.noisyEV;
      }
    }

    const baseEV = this.getEffectiveFairValue(bot, revealedDigits);
    const sigma = BotEngine.SIGMAS[bot.botType] || DEFAULT_SIGMA;
    const noise = this.gaussianRandom() * sigma;
    const noisyEV = baseEV + noise;

    this.beliefs.set(bot.id, {
      noisyEV,
      drawnAt: now,
      revealedCount
    });

    return noisyEV;
  }

  resetBelief(botId) {
    this.beliefs.delete(botId);
  }

  resetBotState(botId) {
    this.botStates.delete(botId);
  }

  // ─── SLOW_REACTOR delay ───────────────────────────────────────

  /**
   * Returns true if the bot should skip this tick because it is
   * in its post-reveal delay window (SLOW_REACTOR only).
   */
  isBotDelayed(bot, revealedDigits) {
    if (bot.botType !== 'SLOW_REACTOR') return false;

    const revealedCount = revealedDigits.length;
    const state = this.botStates.get(bot.id);

    if (!state || state.lastRevealedCount !== revealedCount) {
      // New digit (or first tick) — set a random 3–12 s delay
      const delayMs = 3000 + Math.floor(this.rng() * 9001);
      this.botStates.set(bot.id, {
        lastRevealedCount: revealedCount,
        nextActionTime: Date.now() + delayMs
      });
      return true; // skip this tick
    }

    if (state.nextActionTime && Date.now() < state.nextActionTime) {
      return true;
    }

    return false;
  }

  // ─── FORCED_UNWINDER ──────────────────────────────────────────

  /** True when this bot should switch to unwinding mode. */
  isUnwinding(bot, currentRound) {
    return bot.botType === 'FORCED_UNWINDER' && currentRound >= 5;
  }

  // ─── Personality config helpers ───────────────────────────────

  getMinEdge(bot)  { return BotEngine.MIN_EDGES[bot.botType]  || 0.5; }
  getSpread(bot)   { return BotEngine.SPREADS[bot.botType]    || 1.0; }
  getQuoteProb(bot){ return BotEngine.QUOTE_PROB[bot.botType] || 0.5; }
  getCancelProb(bot){ return BotEngine.CANCEL_PROB[bot.botType]|| 0.2; }

  /**
   * Decides whether the bot should quote BUY or SELL, preferring the
   * side that flattens inventory.  FORCED_UNWINDER in rounds 5-6
   * strongly favours the side that reduces absolute position.
   */
  pickQuoteSide(bot, currentRound) {
    const currentPosition = this.positionEngine.getPosition(bot.id);
    const canBuy = this.positionEngine.canBuy(bot.id, 1);
    const canSell = this.positionEngine.canSell(bot.id, 1);

    if (!canBuy && !canSell) return null;
    if (canBuy && !canSell) return 'BUY';
    if (!canBuy && canSell) return 'SELL';

    // FORCED_UNWINDER in unwinding mode: strongly flatten
    if (this.isUnwinding(bot, currentRound)) {
      if (currentPosition > 0) return 'SELL'; // must reduce long
      if (currentPosition < 0) return 'BUY';  // must cover short
      // flat — either side is fine
      return this.rng() < 0.5 ? 'BUY' : 'SELL';
    }

    if (currentPosition > 0) return this.rng() < 0.7 ? 'SELL' : 'BUY';
    if (currentPosition < 0) return this.rng() < 0.7 ? 'BUY' : 'SELL';
    return this.rng() < 0.5 ? 'BUY' : 'SELL';
  }

  // ─── Quote price generation ───────────────────────────────────

  /**
   * Generates a quote price for a given side around the bot's noisyEV.
   * Checks that the bot does not already have an open order on the
   * same side (caller should cancel the old one first).
   */
  generateQuotePrice(bot, side, noisyEV) {
    const spread = this.getSpread(bot);
    const raw = side === 'BUY' ? noisyEV - spread : noisyEV + spread;
    let price = Math.round(raw);
    price = Math.max(1, Math.min(54, price));

    const existing = this.tradeEngine.getWorkingOrdersForPlayer(bot.id);
    const sameSideSamePrice = existing.some(o => o.side === side && o.price === price);
    if (sameSideSamePrice) {
      price = side === 'BUY' ? Math.max(1, price - 1) : Math.min(54, price + 1);
    }

    return price;
  }

  // ─── Evaluate incoming proposal ───────────────────────────────

  evaluateProposal(bot, proposal, revealedDigits, currentRound) {
    const currentPosition = this.positionEngine.getPosition(bot.id);
    const ev = this.getNoisyEV(bot, revealedDigits);
    const price = proposal.price;
    const botSide = proposal.side === 'BUY' ? 'SELL' : 'BUY';

    if (botSide === 'SELL' && !this.positionEngine.canSell(bot.id, 1)) return 'REJECT';
    if (botSide === 'BUY' && !this.positionEngine.canBuy(bot.id, 1)) return 'REJECT';

    // FORCED_UNWINDER in rounds 5-6: accept anything to unwind
    if (this.isUnwinding(bot, currentRound)) {
      if (botSide === 'SELL' && currentPosition > 0) return 'ACCEPT';
      if (botSide === 'BUY' && currentPosition < 0) return 'ACCEPT';
      // flat or wrong direction — still might accept
      if (botSide === 'SELL' && price >= ev - 2) return 'ACCEPT';
      if (botSide === 'BUY' && price <= ev + 2) return 'ACCEPT';
      return 'REJECT';
    }

    const type = bot.botType || 'BOT_FAIR_VALUE';

    switch (type) {
      case 'SLOW_REACTOR':
      case 'BOT_CONSERVATIVE':
        if (botSide === 'SELL' && price >= ev + 2.0) return 'ACCEPT';
        if (botSide === 'BUY' && price <= ev - 2.0) return 'ACCEPT';
        return 'REJECT';

      case 'OVERREACTOR':
      case 'BOT_AGGRESSIVE':
        if (botSide === 'SELL' && price >= ev - 0.5) return 'ACCEPT';
        if (botSide === 'BUY' && price <= ev + 0.5) return 'ACCEPT';
        return 'REJECT';

      case 'BOT_MARKET_PLAYER':
        if (currentPosition > 0 && botSide === 'SELL' && price >= ev - 1.0) return 'ACCEPT';
        if (currentPosition < 0 && botSide === 'BUY' && price <= ev + 1.0) return 'ACCEPT';
        if (botSide === 'SELL' && price >= ev + 0.5) return 'ACCEPT';
        if (botSide === 'BUY' && price <= ev - 0.5) return 'ACCEPT';
        return 'REJECT';

      case 'BOT_RANDOM': {
        const diff = botSide === 'SELL' ? (price - ev) : (ev - price);
        const acceptProb = Math.max(0.1, Math.min(0.9, 0.5 + diff * 0.1));
        return this.rng() < acceptProb ? 'ACCEPT' : 'REJECT';
      }

      case 'WRONG_BASE':
      case 'BOT_FAIR_VALUE':
      default:
        if (botSide === 'SELL' && price >= ev) return 'ACCEPT';
        if (botSide === 'BUY' && price <= ev) return 'ACCEPT';
        return 'REJECT';
    }
  }

  /**
   * Generates a proactive proposal (bilateral, for backward compat).
   */
  generateProactiveProposal(bot, allPlayers, revealedDigits, currentRound) {
    const ev = this.getNoisyEV(bot, revealedDigits);

    const targets = allPlayers.filter(p => p.id !== bot.id);
    if (targets.length === 0) return null;

    const target = targets[Math.floor(this.rng() * targets.length)];

    const sideResult = this.pickQuoteSide(bot, currentRound);
    if (!sideResult) return null;
    const side = sideResult;

    let price = Math.round(ev);
    const type = bot.botType || 'BOT_FAIR_VALUE';

    switch (type) {
      case 'SLOW_REACTOR':
      case 'BOT_CONSERVATIVE':
        price = side === 'BUY' ? Math.round(ev - 2) : Math.round(ev + 2);
        break;
      case 'OVERREACTOR':
      case 'BOT_AGGRESSIVE':
        price = side === 'BUY' ? Math.round(ev - 0.5) : Math.round(ev + 0.5);
        break;
      case 'BOT_MARKET_PLAYER':
        price = side === 'BUY' ? Math.round(ev - 1) : Math.round(ev + 1);
        break;
      case 'BOT_RANDOM': {
        const offset = (this.rng() * 6 - 3);
        price = Math.round(ev + offset);
        break;
      }
      default:
        price = side === 'BUY' ? Math.floor(ev) : Math.ceil(ev);
    }

    price = Math.max(0, Math.min(54, price));

    return {
      fromPlayerId: bot.id,
      fromPlayerLetter: bot.letter,
      toPlayerId: target.id,
      toPlayerLetter: target.letter,
      side,
      price,
      round: currentRound
    };
  }

  // ─── Personality assignment helpers ────────────────────────────

  /**
   * Returns an array of botType strings for the given number of bots.
   * Guarantees at least one FAIR_VALUE, WRONG_BASE, OVERREACTOR,
   * SLOW_REACTOR.  Remaining slots are filled randomly from the
   * remaining pool.  Shuffled so seats are unpredictable.
   */
  assignPersonalities(botCount) {
    const guaranteed = [...BotEngine.GUARANTEED];
    const pool = [...BotEngine.REMAINING_POOL];

    // If fewer than 4 bots, just assign from pool
    if (botCount <= guaranteed.length) {
      const shuffled = [...guaranteed];
      // Fisher-Yates shuffle using this.rng
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return shuffled.slice(0, botCount);
    }

    // Start with guaranteed, then fill remaining from pool
    const result = [...guaranteed];
    for (let i = guaranteed.length; i < botCount; i++) {
      const pick = pool[Math.floor(this.rng() * pool.length)];
      result.push(pick);
    }

    // Shuffle
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }

    return result;
  }
}