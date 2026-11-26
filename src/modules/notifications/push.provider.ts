import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../infra/config/env.schema.js';

export interface PushPayload {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface PushTicket {
  ok: boolean;
  /** Expo's error code, e.g. DeviceNotRegistered — the token is dead and should be dropped. */
  error?: string;
}

/**
 * Delivery transport. Abstract so tests can substitute a fake and a different
 * provider (direct FCM/APNs) can replace Expo without touching the service.
 * `send` returns exactly one ticket per payload, in order.
 */
export abstract class PushProvider {
  /** Max payloads per `send` call. */
  abstract readonly batchSize: number;
  abstract send(payloads: PushPayload[]): Promise<PushTicket[]>;
}

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';
const TIMEOUT_MS = 15_000;

interface ExpoTicket {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

@Injectable()
export class ExpoPushProvider extends PushProvider {
  readonly batchSize = 100; // Expo's documented per-request cap
  private readonly logger = new Logger(ExpoPushProvider.name);

  constructor(private readonly config: ConfigService<Env, true>) {
    super();
  }

  async send(payloads: PushPayload[]): Promise<PushTicket[]> {
    const token = this.config.get('EXPO_ACCESS_TOKEN', { infer: true });
    const res = await fetch(EXPO_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(
        payloads.map((p) => ({ ...p, sound: 'default', channelId: 'default' })),
      ),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) throw new Error(`Expo push responded ${res.status}`);

    const json = (await res.json()) as { data?: ExpoTicket[] };
    const tickets = json.data;
    if (!Array.isArray(tickets) || tickets.length !== payloads.length) {
      throw new Error('Expo push returned an unexpected ticket list');
    }

    return tickets.map((t) => {
      if (t.status === 'ok') return { ok: true };
      this.logger.warn(`Expo rejected a push: ${t.details?.error ?? t.message ?? 'unknown'}`);
      return { ok: false, error: t.details?.error ?? t.message };
    });
  }
}
