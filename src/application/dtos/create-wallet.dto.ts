import { MoneyPayload } from './submit-transaction.dto.js';

/**
 * Body de `POST /wallets`.
 */
export interface CreateWalletBody {
  playerId: string;
  initialBalance: MoneyPayload;
}
