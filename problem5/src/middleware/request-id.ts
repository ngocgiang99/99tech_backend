import { v4 as uuidv4 } from 'uuid';
import type { RequestHandler } from 'express';

declare module 'express' {
  interface Request {
    id: string;
  }
}

export const requestIdMiddleware: RequestHandler = (req, res, next) => {
  const requestId = (req.headers['x-request-id'] as string | undefined) ?? uuidv4();
  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
};
