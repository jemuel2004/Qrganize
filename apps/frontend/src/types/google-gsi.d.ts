export {};

declare global {
  interface GoogleCredentialResponse {
    credential: string;
    select_by?: string;
  }

  interface GoogleAccountsId {
    initialize(config: {
      client_id: string;
      callback: (response: GoogleCredentialResponse) => void;
      auto_select?: boolean;
      cancel_on_tap_outside?: boolean;
    }): void;
    renderButton(
      parent: HTMLElement,
      options: {
        type?: 'standard' | 'icon';
        theme?: 'outline' | 'filled_blue' | 'filled_black';
        size?: 'large' | 'medium' | 'small';
        text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
        shape?: 'rectangular' | 'pill' | 'circle' | 'square';
        width?: number;
        logo_alignment?: 'left' | 'center';
        /** Button language, e.g. 'en' — otherwise Google follows the browser's language */
        locale?: string;
      }
    ): void;
  }

  interface Window {
    google?: { accounts: { id: GoogleAccountsId } };
  }
}
