export interface TelegramHooksOptions {
  telegramBot: import("telegraf").Telegraf;
}

export interface TelegramFileInfo {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface VisionHooks {
  fetchTelegramFile(fileId: string): Promise<TelegramFileInfo>;
}

export declare function createExtensionHooks(options: TelegramHooksOptions): VisionHooks;
