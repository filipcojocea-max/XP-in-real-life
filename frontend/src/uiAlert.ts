import { Alert, Platform } from 'react-native';

/**
 * Cross-platform alert wrapper. React Native Web's Alert.alert silently
 * no-ops the buttons and (on some setups) the message itself. This utility
 * uses window.alert on web and the native Alert on iOS/Android, so users
 * always see error messages.
 */
export function showAlert(title: string, message?: string) {
  const text = message ? `${title}\n\n${message}` : title;
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    window.alert(text);
    return;
  }
  Alert.alert(title, message);
}

/**
 * Cross-platform confirmation dialog. Returns a Promise<boolean>.
 */
export function showConfirm(
  title: string,
  message?: string,
  opts?: { confirmText?: string; cancelText?: string; destructive?: boolean }
): Promise<boolean> {
  const confirmText = opts?.confirmText || 'OK';
  const cancelText = opts?.cancelText || 'Cancel';
  if (Platform.OS === 'web') {
    const text = message ? `${title}\n\n${message}` : title;
    // eslint-disable-next-line no-alert
    return Promise.resolve(window.confirm(text));
  }
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: cancelText, style: 'cancel', onPress: () => resolve(false) },
      {
        text: confirmText,
        style: opts?.destructive ? 'destructive' : 'default',
        onPress: () => resolve(true),
      },
    ]);
  });
}
