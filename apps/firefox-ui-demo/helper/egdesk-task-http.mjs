import { guardBridgeRequest, readJsonBody, sendJson, setBridgeCors } from './codex-bridge-http.mjs';
import { nativeTaskError } from './egdesk-task-native-store.mjs';

const SCOPE = ['graphId', 'requestId', 'runId', 'parentTaskId', 'requestedBy'];
function fields(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key)) ||
      required.some((key) => !Object.hasOwn(value, key))) {
    throw nativeTaskError('TASK_HTTP_INPUT', 'Invalid task request fields', 400);
  }
}

// The verification receipts remain server-private. UI receives statuses and
// evidence references, never a receipt that can be offered as completion proof.
function publicGraph(value) {
  if (!value) return null;
  return { ...value, tasks: value.tasks.map((task) => {
    const { receipt, approvalReceipt, attempts, lateOutcomes, ...rest } = task;
    return { ...rest, evidenceRefs: receipt?.evidenceRefs ?? [],
      approvalStatus: approvalReceipt?.outcome ?? null,
      attempts: attempts.map(({ attemptId, status }) => ({ attemptId, status })),
      lateOutcomeCount: lateOutcomes.length };
  }) };
}

/**
 * Mount as await handler(req,res,url); false means another handler owns the URL.
 * GET /tasks/state?graphId=ID
 * POST /tasks/submit {boardId,graph} (queues only)
 * POST /tasks/activate|cancel|resume {boardId,scope}
 * POST /tasks/cancel also accepts closeBoard:true; poll board.canClose or await
 * adapter.waitForBoardStop before removing that Board's UI.
 * POST /tasks/retry {boardId,scope,taskId,operationId}
 * POST /tasks/approval {boardId,scope,taskId,approvalId,decision:'approved'|'rejected'}
 * No client execution settings, raw prompt, native approval or receipt endpoint.
 */
export function createTaskHttpHandler({ graph, adapter, ensureAuth, port = 39218 }) {
  if (typeof ensureAuth !== 'function') throw new TypeError('ensureAuth is required');
  function state(graphId) {
    const native = adapter.getState(graphId);
    if (!native) throw nativeTaskError('TASK_NOT_FOUND', 'No registered task graph', 404);
    return { graph: publicGraph(graph.getGraph(graphId)), native,
      board: adapter.boardState(graph, { boardId: native.boardId, requestedBy: native.scope.requestedBy }) };
  }
  return async (req, res) => {
    let url;
    try { url = new URL(req.url, `http://127.0.0.1:${port}`); }
    catch { return false; }
    if (!url.pathname.startsWith('/tasks/')) return false;
    if (!guardBridgeRequest(req, port)) {
      sendJson(res, 403, { code: 'TASK_LOOPBACK_REQUIRED', error: 'Untrusted task request origin' });
      return true;
    }
    setBridgeCors(req, res);
    try {
      if (req.method === 'GET' && url.pathname === '/tasks/state') {
        if ([...url.searchParams.keys()].some((key) => key !== 'graphId') || !url.searchParams.get('graphId')) {
          throw nativeTaskError('TASK_HTTP_INPUT', 'graphId is required', 400);
        }
        await ensureAuth();
        sendJson(res, 200, state(url.searchParams.get('graphId')));
        return true;
      }
      const action = url.pathname.slice('/tasks/'.length);
      if (req.method !== 'POST' || !['submit', 'activate', 'cancel', 'retry', 'resume', 'approval'].includes(action)) {
        sendJson(res, 404, { code: 'TASK_ROUTE_NOT_FOUND', error: 'Unknown task endpoint' });
        return true;
      }
      const body = await readJsonBody(req);
      if (action === 'submit') {
        fields(body, ['boardId', 'graph']);
        await ensureAuth();
        const submitted = await graph.submitGraph(body.graph);
        await adapter.registerGraph({ boardId: body.boardId, graph: submitted });
        sendJson(res, 201, state(submitted.graphId));
        return true;
      }
      const extras = { activate: [], cancel: ['closeBoard'], retry: ['taskId', 'operationId'],
        resume: [], approval: ['taskId', 'approvalId', 'decision'] }[action];
      fields(body, ['boardId', 'scope', ...extras], ['boardId', 'scope', ...(action === 'cancel' ? [] : extras)]);
      fields(body.scope, SCOPE);
      adapter.assertScope(body.scope, body.boardId);
      if (action !== 'cancel') {
        await ensureAuth();
        adapter.assertScope(body.scope, body.boardId);
      }
      if (action === 'cancel') {
        if (body.closeBoard !== undefined && typeof body.closeBoard !== 'boolean') {
          throw nativeTaskError('TASK_HTTP_INPUT', 'closeBoard must be boolean', 400);
        }
        if (body.closeBoard === true) {
          await adapter.cancelBoard(graph, { boardId: body.boardId, requestedBy: body.scope.requestedBy });
        } else {
          await adapter.fenceGraph(body.scope, body.boardId);
          adapter.assertScope(body.scope, body.boardId);
          await graph.cancelGraph(body.scope);
        }
      } else if (action === 'resume') {
        await adapter.reconcile(graph, body.scope);
        adapter.assertScope(body.scope, body.boardId);
        if (!graph.getGraph(body.scope.graphId).cancelRequested) await graph.resumeGraph(body.scope);
      } else if (action === 'approval') {
        const task = graph.getGraph(body.scope.graphId)?.tasks.find((item) => item.taskId === body.taskId);
        if (task?.status !== 'approval-required') throw nativeTaskError('TASK_APPROVAL_STALE', 'Task is not awaiting preapproval');
        await graph.approveTask(await adapter.decideTaskApproval(body));
      } else {
        if (adapter.getState(body.scope.graphId).fenced) throw nativeTaskError('TASK_FENCED', 'Graph is cancelled');
        if (action === 'activate') await graph.activateGraph(body.scope);
        else await graph.retryTask({ ...body.scope, taskId: body.taskId, operationId: body.operationId });
      }
      sendJson(res, action === 'cancel' ? 202 : 200, state(body.scope.graphId));
    } catch (error) {
      const graphStatus = error.code === 'E_TASK_INPUT' ? 400 :
        ['E_TASK_SCOPE', 'E_TASK_STATE', 'E_TASK_IDEMPOTENCY', 'E_TASK_RECONCILE', 'E_TASK_RECEIPT'].includes(error.code) ? 409 : 500;
      sendJson(res, Number.isInteger(error.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599 ?
        error.httpStatus : graphStatus, { code: typeof error.code === 'string' ? error.code : 'TASK_ERROR',
        error: 'Task request could not be completed' });
    }
    return true;
  };
}
