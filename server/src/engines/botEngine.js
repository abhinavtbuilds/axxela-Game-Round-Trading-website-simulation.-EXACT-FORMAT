/**
 * BotEngine
 * 
 * Controls AI bot participants.
 * Strictly adheres to information privacy: bots only use the CURRENTLY REVEALED digits.
 * Implements 5 distinct personalities with private noisy fair-value beliefs so
 * quotes can cross and bot-bot trading occurs naturally.
 * - BOT_FAIR_VALUE
 * - BOT_CONSERVATIVE
 * - BOT_AGGRESSIVE
 * - BOT_MARKET_PLAYER
 * - BOT_RANDOM
 */

const DEFAULT_SIGMA = 0.5;
const BELIEF_TTL_MS = 15_000; // re-draw noise after this long, or on digit reveal

export class BotEngine {
  static PERSONALITIES = [
    'BOT_FAIR_VALUE',
    'BOT_CONSERVATIVE',
    'BOT_AGGRESSIVE',
    'BOT_MARKET_PLAYER',
    'BOT_RANDOM'
  ];

  /**
   * Per-personality sigma for the gaussian noise added to public EV.
   */
  static SIGMAS = {
    BOT_FAIR_VALUE: 0.5,
    BOT_CONSERVATIVE: 1.0,
    BOT_AGGRESSIVE: 2.0,
    BOT_MARKET_PLAYER: 1.5,
    BOT_RANDOM: 3.0
  };

  /**
   * Minimum edge over noisyEV required before a bot will TAKE an order.
   * Higher = more picky.
   */
  static MIN_EDGES = {
    BOT_FAIR_VALUE: 0.5,
    BOT_CONSERVATIVE: 1.0,
    BOT_AGGRESSIVE: 0.5,
    BOT_MARKET_PLAYER: 0.5,
    BOT_RANDOM: 0.0
  };

  /**
   * Spread (one side) when posting a quote around noisyEV.
   * Smaller = tighter to EV, larger = more room for crossing.
   */
  static SPREADS = {
    BOT_FAIR_VALUE: 0.5,
    BOT_CONSERVATIVE: 1.5,
    BOT_AGGRESSIVE: 0.5,
    BOT_MARKET_PLAYER: 1.0,
    BOT_RANDOM: 1.5
  };

  /**
   * Probability of posting a quote when a bot has room (< 2 orders).
   */
  static QUOTE_PROB = {
    BOT_FAIR_VALUE: 0.6,
    BOT_CONSERVATIVE: 0.4,
    BOT_AGGRESSIVE: 0.8,
    BOT_MARKET_PLAYER: 0.6,
    BOT_RANDOM: 0.5
  };

  /**
   * Probability per tick of cancelling the oldest stale order
   * (orders older than 12 s).
   */
  static CANCEL_PROB = {
    BOT_FAIR_VALUE: 0.2,
    BOT_CONSERVATIVE: 0.15,
    BOT_AGGRESSIVE: 0.4,
    BOT_MARKET_PLAYER: 0.25,
    BOT_RANDOM: 0.3
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
  }

  // ─── Seeded gaussian noise (Box-Muller) ───────────────────────

  /**
   * Returns a sample from a standard normal distribution using the
   * instance's RNG.
   */
  gaussianRandom() {
    let u = 0, v = 0;
    while (u === 0) u = this.rng();
    while (v === 0) v = this.rng();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  // ─── Public EV ────────────────────────────────────────────────

  /**
   * Computes expected value from ONLY public revealed digits.
   */
  getPublicFairValue(revealedDigits) {
    const knownSum = revealedDigits.reduce((acc, d) => acc + d, 0);
    const unrevealedCount = 6 - revealedDigits.length;
    return knownSum + unrevealedCount * 4.5;
  }

  // ─── Noisy EV (persistent belief) ─────────────────────────────

  /**
   * Returns this bot's current noisy fair-value belief.
   * The noise is drawn once and persisted; it is re-drawn only when
   * a new digit appears or when BELIEF_TTL_MS has passed.
   *
   * @param {Object} bot - Bot player object ({ id, botType })
   * @param {number[]} revealedDigits
   * @returns {number}
   */
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

    // Draw new belief
    const publicEV = this.getPublicFairValue(revealedDigits);
    const sigma = BotEngine.SIGMAS[bot.botType] || DEFAULT_SIGMA;
    const noise = this.gaussianRandom() * sigma;
    const noisyEV = publicEV + noise;

    this.beliefs.set(bot.id, {
      noisyEV,
      drawnAt: now,
      revealedCount
    });

    return noisyEV;
  }

  /**
   * Resets a bot's belief (used when a new round starts or for cleanup).
   */
  resetBelief(botId) {
    this.beliefs.delete(botId);
  }

  // ─── Personality config helpers ────────────────────────────────

  getMinEdge(bot) {
    return BotEngine.MIN_EDGES[bot.botType] || 0.5;
  }

  getSpread(bot) {
    return BotEngine.SPREADS[bot.botType] || 1.0;
  }

  getQuoteProb(bot) {
    return BotEngine.QUOTE_PROB[bot.botType] || 0.5;
  }

  getCancelProb(bot) {
    return BotEngine.CANCEL_PROB[bot.botType] || 0.2;
  }

  /**
   * Decides whether the bot should quote BUY or SELL, preferring the
   * side that flattens inventory.
   */
  pickQuoteSide(bot) {
    const currentPosition = this.positionEngine.getPosition(bot.id);
    const canBuy = this.positionEngine.canBuy(bot.id, 1);
    const canSell = this.positionEngine.canSell(bot.id, 1);

    if (!canBuy && !canSell) return null;
    if (canBuy && !canSell) return 'BUY';
    if (!canBuy && canSell) return 'SELL';

    // Prefer flattening
    if (currentPosition > 0) return this.rng() < 0.7 ? 'SELL' : 'BUY';
    if (currentPosition < 0) return this.rng() < 0.7 ? 'BUY' : 'SELL';
    return this.rng() < 0.5 ? 'BUY' : 'SELL';
  }

  // ─── Quote price generation ───────────────────────────────────

  /**
   * Generates a quote price for a given side around the bot's noisyEV.
   * Never returns two identical prices on the same side for the same bot.
   */
  generateQuotePrice(bot, side, noisyEV) {
    const spread = this.getSpread(bot);
    const raw = side === 'BUY' ? noisyEV - spread : noisyEV + spread;
    let price = Math.round(raw);

    // Clamp to valid range
    price = Math.max(1, Math.min(54, price));

    // Check that the bot doesn't already have an open order on the same side
    // at this exact price. If it does, nudge by ±1.
    const existing = this.tradeEngine.getWorkingOrdersForPlayer(bot.id);
    const sameSideSamePrice = existing.some(o => o.side === side && o.price === price);
    if (sameSideSamePrice) {
      price = side === 'BUY' ? Math.max(1, price - 1) : Math.min(54, price + 1);
    }

    return price;
  }

  // ─── Order evaluation (backward-compatible but uses noisyEV) ──

  /**
   * Evaluates an incoming proposal targeted at a bot.
   * Uses the bot's noisy fair-value belief.
   */
  evaluateProposal(bot, proposal, revealedDigits) {
    const currentPosition = this.positionEngine.getPosition(bot.id);
    const ev = this.getNoisyEV(bot, revealedDigits);
    const price = proposal.price;
    const botSide = proposal.side === 'BUY' ? 'SELL' : 'BUY';

    if (botSide === 'SELL' && !this.positionEngine.canSell(bot.id, 1)) return 'REJECT';
    if (botSide === 'BUY' && !this.positionEngine.canBuy(bot.id, 1)) return 'REJECT';

    const type = bot.botType || 'BOT_FAIR_VALUE';

    switch (type) {
      case 'BOT_CONSERVATIVE':
        if (botSide === 'SELL' && price >= ev + 2.0) return 'ACCEPT';
        if (botSide === 'BUY' && price <= ev - 2.0) return 'ACCEPT';
        return 'REJECT';

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

      case 'BOT_FAIR_VALUE':
      default:
        if (botSide === 'SELL' && price >= ev) return 'ACCEPT';
        if (botSide === 'BUY' && price <= ev) return 'ACCEPT';
        return 'REJECT';
    }
  }

  /**
   * Generates a proactive proposal (bilateral, for backward compat).
   * Uses the bot's noisyEV.
   */
  generateProactiveProposal(bot, allPlayers, revealedDigits, currentRound) {
    const ev = this.getNoisyEV(bot, revealedDigits);
    const currentPosition = this.positionEngine.getPosition(bot.id);

    const targets = allPlayers.filter(p => p.id !== bot.id);
    if (targets.length === 0) return null;

    const target = targets[Math.floor(this.rng() * targets.length)];

    const sideResult = this.pickQuoteSide(bot);
    if (!sideResult) return null;
    const side = sideResult;

    // Determine price based on personality spread around noisyEV
    let price = Math.round(ev);
    const type = bot.botType || 'BOT_FAIR_VALUE';

    if (type === 'BOT_CONSERVATIVE') {
      price = side === 'BUY' ? Math.round(ev - 2) : Math.round(ev + 2);
    } else if (type === 'BOT_AGGRESSIVE') {
      price = side === 'BUY' ? Math.round(ev - 0.5) : Math.round(ev + 0.5);
    } else if (type === 'BOT_MARKET_PLAYER') {
      price = side === 'BUY' ? Math.round(ev - 1) : Math.round(ev + 1);
    } else if (type === 'BOT_RANDOM') {
      const offset = (this.rng() * 6 - 3);
      price = Math.round(ev + offset);
    } else {
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
}