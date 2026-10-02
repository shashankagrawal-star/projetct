import type { AppContext } from '../context.js';
import { all, get, json, parse, run, transaction } from '../db/connection.js';
import type { ClarificationDraft } from '../domain/types.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from './audit.js';

export interface Clarification {
  qid: string;
  raisedInVersion: number;
  field: string | null;
  question: string;
  options: string[];
  proposedAssumption: string | null;
  blocking: boolean;
  status: 'open' | 'answered' | 'dismissed';
  answer: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  createdAt: string;
}

interface Row {
  qid: string;
  raised_in_version: number;
  field: string | null;
  question: string;
  options: string | null;
  proposed_assumption: string | null;
  blocking: number;
  status: Clarification['status'];
  answer: string | null;
  answered_by: string | null;
  answered_at: string | null;
  created_at: string;
}

const fromRow = (r: Row): Clarification => ({
  qid: r.qid,
  raisedInVersion: r.raised_in_version,
  field: r.field,
  question: r.question,
  options: r.options ? parse<string[]>(r.options) : [],
  proposedAssumption: r.proposed_assumption,
  blocking: r.blocking === 1,
  status: r.status,
  answer: r.answer,
  answeredBy: r.answered_by,
  answeredAt: r.answered_at,
  createdAt: r.created_at,
});

export function listClarifications(ctx: AppContext): Clarification[] {
  return all<Row>(ctx.db, 'SELECT * FROM clarifications ORDER BY id').map(fromRow);
}

export function openBlocking(ctx: AppContext): Clarification[] {
  return all<Row>(ctx.db, "SELECT * FROM clarifications WHERE status = 'open' AND blocking = 1 ORDER BY id").map(fromRow);
}

export function addClarifications(ctx: AppContext, version: number, drafts: ClarificationDraft[], actor: string): Clarification[] {
  return transaction(ctx.db, () => {
    const out: Clarification[] = [];
    for (const d of drafts) {
      // do not re-ask a question that is already open or answered for the same field
      const dup = get<Row>(ctx.db, 'SELECT * FROM clarifications WHERE field IS ? AND lower(question) = lower(?)', [d.field, d.question]);
      if (dup) continue;
      const n = (get<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM clarifications')!.n ?? 0) + 1;
      const qid = `Q${n}`;
      run(
        ctx.db,
        `INSERT INTO clarifications (qid, raised_in_version, field, question, options, proposed_assumption, blocking, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
        [qid, version, d.field, d.question, json(d.options ?? []), d.proposedAssumption ?? null, d.blocking, ctx.now()],
      );
      out.push(fromRow(get<Row>(ctx.db, 'SELECT * FROM clarifications WHERE qid = ?', [qid])!));
    }
    if (out.length > 0) audit(ctx, actor, 'clarification.raised', 'plan_version', version, { qids: out.map((q) => q.qid) });
    return out;
  });
}

export function answerClarification(ctx: AppContext, qid: string, input: { answer?: string; acceptAssumption?: boolean; dismiss?: boolean }, actor: string): Clarification {
  const row = get<Row>(ctx.db, 'SELECT * FROM clarifications WHERE qid = ?', [qid]);
  if (!row) throw notFound(`Clarification ${qid}`);
  if (row.status !== 'open') throw conflict(`Clarification ${qid} is already ${row.status}`);

  let status: 'answered' | 'dismissed' = 'answered';
  let answer: string | null = input.answer?.trim() || null;
  if (input.dismiss) {
    status = 'dismissed';
    answer = answer ?? 'Dismissed: not applicable';
  } else if (input.acceptAssumption) {
    if (!row.proposed_assumption) throw badRequest('This question has no proposed assumption to accept');
    answer = row.proposed_assumption;
  }
  if (!answer) throw badRequest('Provide an answer, accept the proposed assumption, or dismiss the question');

  run(ctx.db, 'UPDATE clarifications SET status = ?, answer = ?, answered_by = ?, answered_at = ? WHERE qid = ?', [status, answer, actor, ctx.now(), qid]);
  audit(ctx, actor, status === 'dismissed' ? 'clarification.dismissed' : 'clarification.answered', 'clarification', qid, { field: row.field, answer });
  return fromRow(get<Row>(ctx.db, 'SELECT * FROM clarifications WHERE qid = ?', [qid])!);
}
