import { TeamSide } from "@prisma/client";
import { badRequest } from "./errors.js";

export type ScoreInput = { teamAScore: number; teamBScore: number };

export type ScoreSettings = {
  pointsToWin: number;
  winBy: number;
  scoreCap: number | null;
  bestOf: number;
};

export type ValidatedScore = ScoreInput & { winnerTeam: TeamSide };

export function validateScores(games: ScoreInput[], settings: ScoreSettings): ValidatedScore[] {
  if (!Array.isArray(games) || games.length === 0 || games.length > settings.bestOf) {
    throw badRequest("The number of games does not match the session scoring rules.");
  }
  const requiredWins = Math.floor(settings.bestOf / 2) + 1;
  let aWins = 0;
  let bWins = 0;
  const validated: ValidatedScore[] = [];

  for (const game of games) {
    if (!Number.isInteger(game.teamAScore) || !Number.isInteger(game.teamBScore) || game.teamAScore < 0 || game.teamBScore < 0) {
      throw badRequest("Scores must be non-negative integers.");
    }
    if (game.teamAScore === game.teamBScore) throw badRequest("A game cannot end in a tie.");
    const high = Math.max(game.teamAScore, game.teamBScore);
    const low = Math.min(game.teamAScore, game.teamBScore);
    if (settings.scoreCap !== null && (high > settings.scoreCap || low > settings.scoreCap)) {
      throw badRequest("Scores cannot exceed the configured cap.");
    }
    const reachesCap = settings.scoreCap !== null && high === settings.scoreCap;
    const validRace = reachesCap ? high === settings.scoreCap && low < high : high >= settings.pointsToWin && high - low >= settings.winBy;
    if (!validRace) throw badRequest("The submitted score does not satisfy the session rules.");
    const winnerTeam = game.teamAScore > game.teamBScore ? TeamSide.A : TeamSide.B;
    validated.push({ ...game, winnerTeam });
    if (winnerTeam === TeamSide.A) aWins += 1;
    else bWins += 1;
    if (aWins >= requiredWins || bWins >= requiredWins) break;
  }
  if (aWins < requiredWins && bWins < requiredWins) throw badRequest("The match series is not complete.");
  if (validated.length !== games.length) throw badRequest("No games may be submitted after the match is already won.");
  return validated;
}

