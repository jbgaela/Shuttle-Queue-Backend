import { Prisma } from "@prisma/client";

export type AuditValues = {
  action: string;
  entityType: string;
  entityId: string;
  reason?: string;
  before?: unknown;
  after?: unknown;
};

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function auditLogData(queueMasterId: string, requestId: string, values: AuditValues): Prisma.AuditLogUncheckedCreateInput {
  return {
    queueMasterId,
    action: values.action,
    entityType: values.action === "PLAYERS_DELETED" ? "QUEUE_PLAYER" : values.entityType,
    entityId: values.entityId,
    ...(values.reason === undefined ? {} : { reason: values.reason }),
    ...(values.before === undefined ? {} : { beforeJson: jsonValue(values.before) }),
    ...(values.after === undefined ? {} : { afterJson: jsonValue(values.after) }),
    requestId,
  };
}
