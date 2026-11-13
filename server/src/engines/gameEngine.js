import { randomUUID } from 'node:crypto';
import { DigitRevealEngine } from './digitRevealEngine.js';
import { PositionEngine } from './positionEngine.js';
import { PnlEngine } from './pnlEngine.js';
import { TradeEngine } from './tradeEngine.js';
import { RoundManager } from './roundManager.js';
import { LeaderboardEngine } from './leaderboardEngine.js';
import { BotEngine } from './botEngine.js';
import { SettlementEngine } from './settlementEngine.js';

export const PLAYER_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

/**
 * GameEngine
 * 
 * Authoritative coordinator for a single trading game session.
 * Manages all domain engines, player seats, lifecycle events, and client synchronization.
 */
export class GameEngine {
  constructor(options = {}) {
    this.id = options.id || randomUUID();
    this.roomId = options.roomId;
    this.roomCode = options.roomCode;
    this.hostId = options.hostId;
    this.isPracticeMode = options.isPracticeMode || false;
    this.isDeterministicDemo = options.isDeterministicDemo || false;
    this.maxPlayers = options.maxPlayers || 6;
    this.roundDurationSeconds = options.roundDurationSeconds || 90;

    // Sub-engines
    this.digitEngine = new DigitRevealEngine({
      isDeterministicDemo: this.isDeterministicDemo,
      digits: options.demoDigits
    });
    this.positionEngine = new PositionEngine();
    this.pnlEngine = new PnlEngine();
    this.tradeEngine = new TradeEngine(this.positionEngine, this.pnlEngine);
    this.botEngine = new BotEngine(this.tradeEngine, this.positionEngine);

    // Players list: Array<{ id, letter, nickname, isBot, botType, socketId, connected }>
    this.players = [];

    // State
    this.status = 'LOBBY'; // LOBBY, INSTRUCTIONS, TRADING, TRANSITION, SETTLEMENT, FINISHED
    this.settlementResults = null;
    this.botActivityInterval = null;
    this.botIntervals = new Map(); // playerId -> intervalId (Phase 1: per-bot timers)

    // Callbacks to notify socket layer
    this.emitEvent = options.emitEvent || (() => {});

    // Initialize Round Manager
    this.roundManager = new RoundManager({
      roundDurationSeconds: this.roundDurationSeconds,
      onTick: (tickData) => this.handleTick(tickData),
      onRoundEnd: (data) => this.handleRoundEnd(data),
      onTransitionEnd: (data) => this.handleTransitionEnd(data),
      onGameEnd: (data) => this.handleGameEnd(data)
    });
  }

  /**
   * Adds a human player or assigns a seat.
   */
  addPlayer({ id, nickname, socketId, isHost = false }) {
    if (this.players.length >= this.maxPlayers) {
      throw new Error("Game room is full");
    }

    const assignedLetter = PLAYER_LETTERS[this.players.length];
    const player = {
      id: id || randomUUID(),
      letter: assignedLetter,
      nickname: nickname || `Player ${assignedLetter}`,
      isBot: false,
      botType: null,
      socketId,
      connected: true,
      isHost: isHost || this.players.length === 0
    };

    this.players.push(player);
    this.positionEngine.initPlayer(player.id);
    this.pnlEngine.initPlayer(player.id);

    return player;
  }

  /**
   * Fills remaining empty seats up to maxPlayers with AI bots.
   */
  fillEmptySeatsWithBots() {
    let personalityIndex = 0;
    while (this.players.length < this.maxPlayers) {
      const assignedLetter = PLAYER_LETTERS[this.players.length];
      const botType = BotEngine.PERSONALITIES[personalityIndex % BotEngine.PERSONALITIES.length];
      personalityIndex++;

      const bot = {
        id: `bot-${assignedLetter.toLowerCase()}-${randomUUID().substring(0, 6)}`,
        letter: assignedLetter,
        nickname: `BOT ${assignedLetter}`,
        isBot: true,
        botType,
        socketId: null,
        connected: true,
        isHost: false
      };

      this.players.push(bot);
      this.positionEngine.initPlayer(bot.id);
      this.pnlEngine.initPlayer(bot.id);
    }
  }

  /**
   * Transitions from Lobby to Instructions phase.
   */
  showInstructions() {
    this.status = 'INSTRUCTIONS';
    this.emitEvent('game:instructions', {
      gameId: this.id,
      status: this.status
    });
  }

  /**
   * Starts the actual game at Round 1.
   */
  startGame() {
    // Fill remaining seats with bots if not full
    this.fillEmptySeatsWithBots();

    this.status = 'TRADING';
    this.roundManager.startRound(1);
    this.startBotActivityLoop();

    this.emitEvent('game:start', {
      gameId: this.id,
      round: 1,
      timeRemaining: this.roundManager.timeRemaining,
      revealedDigits: this.digitEngine.getRevealedDigitsForRound(1, false),
      players: this.getPublicPlayers()
    });
  }

  /**
   * Background loop for bot trade participation and market quoting.
   * Phase 1: Each bot gets its own timer with a random 2-6 s delay.
   */
  startBotActivityLoop() {
    // Clear any existing intervals
    this.stopBotActivityLoop();

    const bots = this.players.filter(p => p.isBot);
    for (const bot of bots) {
      const delayMs = 2000 + Math.floor(Math.random() * 4001); // 2000-6000 ms
      const intervalId = setInterval(() => {
        if (this.status !== 'TRADING') return;
        this.executeBotTick(bot);
      }, delayMs);
      this.botIntervals.set(bot.id, intervalId);
    }
  }

  /**
   * Clears all per-bot timer intervals.
   */
  stopBotActivityLoop() {
    for (const [id, intervalId] of this.botIntervals) {
      clearInterval(intervalId);
    }
    this.botIntervals.clear();
    // Also clear the old single-interval reference in case anything still holds it
    if (this.botActivityInterval) {
      clearInterval(this.botActivityInterval);
      this.botActivityInterval = null;
    }
  }

  /**
   * Executes one tick of activity for a single bot using its private
   * noisy fair-value belief so that quotes from different bots can cross.
   *
   * (a) Look at open orders from others → TAKE the best one that beats
   *     the bot's noisyEV by at least its personality's minimum edge,
   *     provided the bot has room under ±2.
   * (b) Otherwise, if < 2 own orders, post one quote around noisyEV
   *     with the personality-appropriate spread. Never post two
   *     identical quotes on the same side.
   * (c) Cancel own stale orders after a digit reveal or randomly.
   */
  executeBotTick(bot) {
    const revealedDigits = this.digitEngine.getRevealedDigitsForRound(
      this.roundManager.currentRound, false
    );

    // ── (a) Look for orders to TAKE ──────────────────────────────
    const openOrders = this.tradeEngine.getAllOpenWorkingOrders()
      .filter(o => o.playerId !== bot.id);
    const minEdge = this.botEngine.getMinEdge(bot);
    const noisyEV = this.botEngine.getNoisyEV(bot, revealedDigits);

    // Find the best order: highest BUY price (we sell) or lowest SELL price (we buy)
    let bestOrder = null;
    let bestScore = -Infinity;

    for (const order of openOrders) {
      if (order.side === 'BUY' && this.positionEngine.canSell(bot.id, 1)) {
        // Maker wants to BUY — bot would SELL. Edge = price - noisyEV.
        const edge = order.price - noisyEV;
        if (edge >= minEdge && edge > bestScore) {
          bestScore = edge;
          bestOrder = order;
        }
      } else if (order.side === 'SELL' && this.positionEngine.canBuy(bot.id, 1)) {
        // Maker wants to SELL — bot would BUY. Edge = noisyEV - price.
        const edge = noisyEV - order.price;
        if (edge >= minEdge && edge > bestScore) {
          bestScore = edge;
          bestOrder = order;
        }
      }
    }

    if (bestOrder) {
      try {
        const res = this.tradeEngine.takeWorkingOrder(bestOrder.id, bot.id, bot.letter);
        this.broadcastTradeExecution(res);
        return; // Tick ends — don't post and take in the same tick
      } catch (e) {
        // Order might have been taken by someone else; continue to quote
      }
    }

    // ── (b) Post a quote if we have room ─────────────────────────
    const botOrdersCount = this.tradeEngine.getActiveWorkingOrdersCount(bot.id);
    if (botOrdersCount < 2 && Math.random() < this.botEngine.getQuoteProb(bot)) {
      const side = this.botEngine.pickQuoteSide(bot);
      if (side) {
        const price = this.botEngine.generateQuotePrice(bot, side, noisyEV);
        if (price >= 0 && price <= 54) {
          try {
            const order = this.tradeEngine.createWorkingOrder({
              playerId: bot.id,
              playerLetter: bot.letter,
              side,
              price,
              round: this.roundManager.currentRound
            });
            this.emitEvent('order:created', { order });
          } catch (e) {
            // Position limit or order limit hit — skip silently
          }
        }
      }
    }

    // ── (c) Cancel stale orders ──────────────────────────────────
    if (Math.random() < this.botEngine.getCancelProb(bot)) {
      const myOrders = this.tradeEngine.getWorkingOrdersForPlayer(bot.id);
      if (myOrders.length > 0 && Date.now() - myOrders[0].createdAt > 12000) {
        try {
          this.tradeEngine.cancelWorkingOrder(myOrders[0].id, bot.id);
          this.emitEvent('order:cancelled', { orderId: myOrders[0].id });
        } catch (e) {}
      }
    }
  }

  /**
   * Place a broadcasted working order on the table.
   * Maximum 2 working orders allowed per player at a time!
   */
  createWorkingOrder(playerId, side, price) {
    if (this.status !== 'TRADING') {
      throw new Error("Trading is currently closed");
    }

    const player = this.players.find(p => p.id === playerId);
    if (!player) throw new Error("Player not found");

    const order = this.tradeEngine.createWorkingOrder({
      playerId: player.id,
      playerLetter: player.letter,
      side,
      price,
      round: this.roundManager.currentRound
    });

    this.emitEvent('order:created', { order });
    return order;
  }

  /**
   * Take another player's working order from the table.
   */
  takeOrder(takerId, orderId) {
    if (this.status !== 'TRADING') {
      throw new Error("Trading is currently closed");
    }

    const taker = this.players.find(p => p.id === takerId);
    if (!taker) throw new Error("Player not found");

    const result = this.tradeEngine.takeWorkingOrder(orderId, taker.id, taker.letter);
    this.broadcastTradeExecution(result);
    return result;
  }

  /**
   * Cancel an open working order.
   */
  cancelOrder(cancellingPlayerId, orderId) {
    const order = this.tradeEngine.cancelWorkingOrder(orderId, cancellingPlayerId);
    this.emitEvent('order:cancelled', { orderId });
    return order;
  }

  /**
   * Backward compatibility for proposals.
   */
  createProposal(fromPlayerId, toPlayerLetter, side, price) {
    return this.createWorkingOrder(fromPlayerId, side, price);
  }

  acceptProposal(orderId, acceptingPlayerId) {
    return this.takeOrder(acceptingPlayerId, orderId);
  }

  cancelProposal(orderId, cancellingPlayerId) {
    return this.cancelOrder(cancellingPlayerId, orderId);
  }

  rejectProposal(orderId) {
    return { id: orderId };
  }

  /**
   * Broadcasts updates when a trade successfully executes.
   */
  broadcastTradeExecution(result) {
    const { trade, posResult, pnlResult } = result;

    this.emitEvent('trade:executed', {
      trade,
      leaderboard: this.getLeaderboard(),
      positions: {
        [trade.buyerId]: posResult.buyerPosition,
        [trade.sellerId]: posResult.sellerPosition
      },
      pnl: {
        [trade.buyerId]: pnlResult.buyerTotalRealized,
        [trade.sellerId]: pnlResult.sellerTotalRealized
      }
    });
  }

  nextRound() {
    if (this.roundManager.currentRound < RoundManager.TOTAL_ROUNDS) {
      const nextRound = this.roundManager.currentRound + 1;
      this.roundManager.startRound(nextRound);
      const revealedDigits = this.digitEngine.getRevealedDigitsForRound(nextRound, false);
      this.emitEvent('game:roundStart', {
        round: nextRound,
        timeRemaining: this.roundManager.roundDuration,
        revealedDigits,
        newlyRevealedDigit: revealedDigits[revealedDigits.length - 1]
      });
    } else {
      this.roundManager.handleRoundFinish();
    }
  }

  /**
   * Authoritative timer tick handler.
   */
  handleTick(tickData) {
    this.emitEvent('game:timer', {
      round: tickData.round,
      timeRemaining: tickData.timeRemaining,
      state: tickData.state
    });
  }

  /**
   * Round finishes (90s elapsed).
   */
  handleRoundEnd({ round }) {
    this.status = 'TRANSITION';
    // Expire open proposals for this round
    this.tradeEngine.expireRoundProposals(round);

    this.emitEvent('game:roundEnd', {
      finishedRound: round,
      revealedDigits: this.digitEngine.getRevealedDigitsForRound(round, false)
    });
  }

  /**
   * Transition ends and next round starts.
   */
  handleTransitionEnd({ nextRound }) {
    this.status = 'TRADING';
    const revealedDigits = this.digitEngine.getRevealedDigitsForRound(nextRound, false);

    this.emitEvent('game:roundStart', {
      round: nextRound,
      timeRemaining: this.roundManager.roundDuration,
      revealedDigits,
      newlyRevealedDigit: revealedDigits[revealedDigits.length - 1]
    });
  }

  /**
   * Round 6 terminates: reveal 6th digit and settle remaining positions.
   */
  handleGameEnd() {
    this.status = 'FINISHED';
    this.stopBotActivityLoop();

    // Reveal ALL 6 digits
    const finalDigits = this.digitEngine.getRevealedDigitsForRound(6, true);
    const finalSum = this.digitEngine.getFinalSum();

    // Settle open lots
    const openLotsMap = new Map();
    const realizedPnlMap = new Map();

    for (const player of this.players) {
      openLotsMap.set(player.id, this.pnlEngine.getOpenLots(player.id));
      realizedPnlMap.set(player.id, this.pnlEngine.getRealizedPnL(player.id));
    }

    this.settlementResults = SettlementEngine.settleAll(finalSum, openLotsMap, realizedPnlMap);

    this.emitEvent('game:settlement', {
      finalDigits,
      finalSum,
      settlementResults: this.settlementResults,
      leaderboard: this.getLeaderboard()
    });
  }

  /**
   * Generates sanitized client state for a given player.
   * GUARANTEES: Future hidden digits are NEVER leaked!
   */
  getClientState(playerId) {
    const player = this.players.find(p => p.id === playerId);
    const isFinished = this.status === 'FINISHED';
    const revealedDigits = this.digitEngine.getRevealedDigitsForRound(this.roundManager.currentRound, isFinished);

    let practiceStats = null;
    if (this.isPracticeMode) {
      practiceStats = this.digitEngine.getExpectedValue(this.roundManager.currentRound, isFinished);
    }

    return {
      gameId: this.id,
      roomCode: this.roomCode,
      status: this.status,
      currentRound: this.roundManager.currentRound,
      timeRemaining: this.roundManager.timeRemaining,
      roundDurationSeconds: this.roundManager.roundDuration,
      revealedDigits,
      isPracticeMode: this.isPracticeMode,
      isDeterministicDemo: this.isDeterministicDemo,
      players: this.getPublicPlayers(),
      myPlayer: player || null,
      myPosition: player ? this.positionEngine.getPosition(player.id) : 0,
      myRealizedPnL: player ? this.pnlEngine.getRealizedPnL(player.id) : 0,
      workingOrders: player ? this.tradeEngine.getWorkingOrdersForPlayer(player.id) : [],
      openTableOrders: this.tradeEngine.getAllOpenWorkingOrders(),
      incomingProposals: player ? this.tradeEngine.getIncomingProposalsForPlayer(player.id) : [],
      myTrades: player ? this.tradeEngine.getTradesForPlayer(player.id) : [],
      leaderboard: this.getLeaderboard(),
      settlementResults: this.settlementResults,
      practiceStats,
      allTrades: isFinished ? this.tradeEngine.getAllTrades() : undefined
    };
  }

  getLeaderboard() {
    return LeaderboardEngine.getLeaderboard(this.players, this.pnlEngine, this.settlementResults);
  }

  getPublicPlayers() {
    return this.players.map(p => ({
      id: p.id,
      letter: p.letter,
      nickname: p.nickname,
      isBot: p.isBot,
      isHost: p.isHost,
      connected: p.connected
    }));
  }

  destroy() {
    this.stopBotActivityLoop();
    this.roundManager.destroy();
  }
}
