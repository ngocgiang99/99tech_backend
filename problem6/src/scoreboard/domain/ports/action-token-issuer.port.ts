export interface IssuedActionToken {
  actionId: string;
  actionToken: string;
  expiresAt: Date;
  maxDelta: number;
}

export interface ActionTokenIssuer {
  issue(input: {
    sub: string;
    atp: string;
    mxd: number;
  }): Promise<IssuedActionToken>;
}

export const ACTION_TOKEN_ISSUER = Symbol('ACTION_TOKEN_ISSUER');
