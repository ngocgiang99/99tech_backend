import { SignJWT } from 'jose';
import crypto from 'node:crypto';

const secret = process.env.INTERNAL_JWT_SECRET;
if (!secret) {
  console.error('INTERNAL_JWT_SECRET not set');
  process.exit(1);
}
const sub = process.argv[2] || crypto.randomUUID();
const jwt = await new SignJWT({ sub })
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject(sub)
  .setIssuedAt()
  .setExpirationTime('10m')
  .sign(new TextEncoder().encode(secret));
console.log(JSON.stringify({ sub, jwt }));
