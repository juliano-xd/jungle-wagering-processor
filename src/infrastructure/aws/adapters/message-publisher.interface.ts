/**
 * Contrato do publicador de mensagens.
 *
 * Usamos uma classe abstrata (em vez de interface) para que possa servir
 * de token de injeção de dependência no NestJS.
 */
export abstract class MessagePublisher {
  abstract publish(queueUrl: string, payload: any): Promise<void>;
}