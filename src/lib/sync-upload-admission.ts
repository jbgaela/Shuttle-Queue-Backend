import type { Request, RequestHandler, Response } from "express";

type PendingUpload = {
  request: Request;
  response: Response;
  next: Parameters<RequestHandler>[2];
  accountId: string | null;
  cancelled: boolean;
  release?: () => void;
  removeQueueListeners?: () => void;
};

const uploadReleases = new WeakMap<Request, () => void>();
const parsedUploads = new WeakSet<Request>();
const SYNC_UPLOAD_PATH = "/api/v2/sync/snapshot";
const DEFAULT_ACTIVE_UPLOADS = 12;
const DEFAULT_QUEUED_UPLOADS = 256;
const DEFAULT_ACTIVE_UPLOADS_PER_ACCOUNT = 1;

export function createSyncUploadAdmission(
  maximumActive = DEFAULT_ACTIVE_UPLOADS,
  maximumQueued = DEFAULT_QUEUED_UPLOADS,
  maximumActivePerAccount = DEFAULT_ACTIVE_UPLOADS_PER_ACCOUNT,
): RequestHandler {
  let active = 0;
  const activeByAccount = new Map<string, number>();
  const servedAccounts = new Set<string>();
  const waiting: PendingUpload[] = [];

  const canAdmit = (pending: PendingUpload) =>
    active < maximumActive &&
    (!pending.accountId || (activeByAccount.get(pending.accountId) ?? 0) < maximumActivePerAccount);

  const drain = () => {
    while (active < maximumActive && waiting.length) {
      const accountsInCycle = new Set([
        ...activeByAccount.keys(),
        ...waiting.flatMap((pending) => (pending.accountId ? [pending.accountId] : [])),
      ]);
      if ([...accountsInCycle].every((accountId) => servedAccounts.has(accountId)))
        servedAccounts.clear();
      const index = waiting.findIndex(
        (pending) =>
          canAdmit(pending) && (!pending.accountId || !servedAccounts.has(pending.accountId)),
      );
      const nextIndex = index >= 0 ? index : waiting.findIndex(canAdmit);
      if (nextIndex < 0) return;
      const [pending] = waiting.splice(nextIndex, 1);
      if (!pending) continue;
      pending.removeQueueListeners?.();
      if (!pending.cancelled && !pending.response.destroyed) {
        if (pending.accountId) servedAccounts.add(pending.accountId);
        admit(pending);
      }
    }
  };

  const admit = (pending: PendingUpload) => {
    active += 1;
    if (pending.accountId)
      activeByAccount.set(pending.accountId, (activeByAccount.get(pending.accountId) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active -= 1;
      if (pending.accountId) {
        const accountActive = (activeByAccount.get(pending.accountId) ?? 1) - 1;
        if (accountActive === 0) activeByAccount.delete(pending.accountId);
        else activeByAccount.set(pending.accountId, accountActive);
      }
      uploadReleases.delete(pending.request);
      pending.request.removeListener("aborted", releaseIfBodyIncomplete);
      pending.response.removeListener("finish", release);
      pending.response.removeListener("close", releaseIfBodyIncomplete);
      drain();
    };
    const releaseIfBodyIncomplete = () => {
      if (pending.response.writableFinished || !parsedUploads.has(pending.request)) release();
    };

    pending.release = release;
    uploadReleases.set(pending.request, release);
    pending.request.once("aborted", releaseIfBodyIncomplete);
    pending.response.once("finish", release);
    pending.response.once("close", releaseIfBodyIncomplete);
    pending.next();
  };

  return (request, response, next) => {
    const path = request.originalUrl.split("?", 1)[0]!.replace(/\/+$/, "");
    if (request.method !== "PUT" || path !== SYNC_UPLOAD_PATH) {
      next();
      return;
    }

    const accountId = (request as Request & { auth?: { queueMaster?: { id?: string } } }).auth
      ?.queueMaster?.id;
    const pending: PendingUpload = {
      request,
      response,
      next,
      accountId: accountId ?? null,
      cancelled: false,
    };
    if (canAdmit(pending)) {
      if (pending.accountId) servedAccounts.add(pending.accountId);
      admit(pending);
      return;
    }
    if (waiting.length >= maximumQueued) {
      request.resume();
      response.setHeader("Retry-After", "2");
      response.status(503).json({
        error: {
          code: "SYNC_BUSY",
          message: "Sync is busy. Your saved offline work remains pending; retry shortly.",
        },
        requestId: response.locals.requestId,
      });
      return;
    }

    const removeFromQueue = () => {
      if (pending.cancelled) return;
      pending.cancelled = true;
      const index = waiting.indexOf(pending);
      if (index >= 0) waiting.splice(index, 1);
      pending.removeQueueListeners?.();
      drain();
    };
    pending.removeQueueListeners = () => {
      request.removeListener("aborted", removeFromQueue);
      response.removeListener("close", removeFromQueue);
    };
    request.once("aborted", removeFromQueue);
    response.once("close", removeFromQueue);
    waiting.push(pending);
  };
}

export function markSyncUploadBodyParsed(request: Request) {
  if (uploadReleases.has(request)) parsedUploads.add(request);
}

export function releaseSyncUploadAdmission(request: Request) {
  uploadReleases.get(request)?.();
}
