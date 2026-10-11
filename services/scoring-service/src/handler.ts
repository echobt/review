import type { Message } from "@review/core";
import type { ScoringService } from "./service.ts";

/** score.requested -> ScoreReport persisted in score_reports (failed jobs are persisted with the error). */
export const makeHandler = (svc: ScoringService) => async (msg: Message<"score.requested">): Promise<void> => {
  await svc.scoreReview(msg);
};
