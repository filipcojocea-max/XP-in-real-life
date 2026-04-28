/**
 * Global ALL-TEXT-YELLOW override for the Creator/Admin (Premium+) account.
 *
 * Cross-platform implementation:
 *  - On web: injects a <style> tag setting all text-bearing elements to gold.
 *  - On native: patches Text.render so every <Text> gets a final golden
 *    color appended to its style array.
 *  - The patch is keyed off `_adminActive`; toggling it on/off forces a
 *    repaint via the React subtree.
 */
import React from 'react';
import { Text, Platform, StyleSheet } from 'react-native';

const ADMIN_GOLD = '#FFD700';

const _OVERRIDE_STYLE = StyleSheet.create({
  adminText: { color: ADMIN_GOLD },
}).adminText;

let _adminActive = false;
let _patched = false;
let _webStyleEl: any = null;

export function isAdminTextOverrideOn(): boolean {
  return _adminActive;
}

function _patchOnce() {
  if (_patched) return;
  _patched = true;
  const TextAny: any = Text as any;
  const originalRender = TextAny.render;
  if (typeof originalRender === 'function') {
    TextAny.render = function adminAwareRender(...args: any[]) {
      const elem = originalRender.apply(this, args);
      if (!_adminActive || !elem || !elem.props) return elem;
      const incoming = elem.props.style;
      const nextStyle = Array.isArray(incoming)
        ? [...incoming, _OVERRIDE_STYLE]
        : incoming != null
          ? [incoming, _OVERRIDE_STYLE]
          : _OVERRIDE_STYLE;
      return React.cloneElement(elem, { style: nextStyle });
    };
  }
}

function _ensureWebStyleSheet() {
  if (Platform.OS !== 'web') return;
  if (typeof document === 'undefined') return;
  if (_webStyleEl) return;
  const el = document.createElement('style');
  el.id = 'admin-yellow-override';
  // High-specificity selector: every visible element & every Text descendant.
  el.textContent = `
    body.admin-yellow-mode,
    body.admin-yellow-mode * {
      color: ${ADMIN_GOLD} !important;
    }
    body.admin-yellow-mode input,
    body.admin-yellow-mode textarea,
    body.admin-yellow-mode [role="textbox"] {
      color: ${ADMIN_GOLD} !important;
      caret-color: ${ADMIN_GOLD} !important;
    }
    body.admin-yellow-mode [data-text],
    body.admin-yellow-mode div[role="text"],
    body.admin-yellow-mode div[dir="auto"] {
      color: ${ADMIN_GOLD} !important;
    }
  `;
  document.head.appendChild(el);
  _webStyleEl = el;
}

export function enableAdminTextOverride() {
  _patchOnce();
  _adminActive = true;
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    _ensureWebStyleSheet();
    document.body.classList.add('admin-yellow-mode');
  }
}

export function disableAdminTextOverride() {
  _adminActive = false;
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    document.body.classList.remove('admin-yellow-mode');
  }
}
