export interface CallbackQuery {
  id: string;
  data: string;
  chatId: string;
  messageId: number;
  userId: number;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export type CallbackHandler = (query: CallbackQuery) => Promise<void>;
