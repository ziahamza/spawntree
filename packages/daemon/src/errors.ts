import { Schema } from "effect";

export class BadRequestError extends Schema.TaggedErrorClass<BadRequestError>()("BadRequestError", {
  code: Schema.String,
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
}) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("ConflictError", {
  code: Schema.String,
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
}) {}

export class InternalError extends Schema.TaggedErrorClass<InternalError>()("InternalError", {
  code: Schema.String,
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("NotFoundError", {
  code: Schema.String,
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
}) {}
