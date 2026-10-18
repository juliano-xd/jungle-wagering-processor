import { WagerTransactionKind } from '../../domain/entities/wager-transaction.js';

export interface MoneyPayload {
  amount: string;
  currency: string;
}

/**
 * Body de `POST /wagering/transactions`.
 *
 * Não usa class-validator para manter a camada HTTP portátil (o domínio já
 * valida via `Money.from` e `WagerTransaction.create`). A validação mínima
 * (campos obrigatórios e tipos) fica no controller para retornar 400 antes
 * de chegar ao domínio.
 */
export interface SubmitTransactionBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyPayload;
  referenceExternalTransactionId?: string;
}
