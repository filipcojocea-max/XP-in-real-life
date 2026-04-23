export const colors = {
  bg: '#05070D',
  surface: '#0A0E1A',
  surfaceGlass: 'rgba(255,255,255,0.05)',
  surfaceGlassActive: 'rgba(255,255,255,0.1)',
  border: 'rgba(255,255,255,0.08)',
  borderStrong: 'rgba(255,255,255,0.16)',
  text: '#FFFFFF',
  textSecondary: 'rgba(255,255,255,0.65)',
  textMuted: 'rgba(255,255,255,0.4)',
  green: '#00FF88',
  cyan: '#00D9FF',
  amber: '#FFB800',
  pink: '#FF3366',
  purple: '#9D4CDD',
  red: '#FF3B30',
  glowGreen: 'rgba(0,255,136,0.5)',
  glowCyan: 'rgba(0,217,255,0.5)',
};

export type FocusArea = 'social' | 'fitness' | 'appearance' | 'mindset';
export type TimeSlot = 'morning' | 'afternoon' | 'evening';

export const focusMeta: Record<FocusArea, { label: string; color: string; icon: string }> = {
  social:     { label: 'Social',     color: colors.cyan,   icon: 'chatbubbles' },
  fitness:    { label: 'Fitness',    color: colors.green,  icon: 'barbell' },
  appearance: { label: 'Appearance', color: colors.pink,   icon: 'shirt' },
  mindset:    { label: 'Mindset',    color: colors.purple, icon: 'planet' },
};

export const slotMeta: Record<TimeSlot, { label: string; icon: string }> = {
  morning:   { label: 'Morning',   icon: 'sunny' },
  afternoon: { label: 'Afternoon', icon: 'partly-sunny' },
  evening:   { label: 'Evening',   icon: 'moon' },
};

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 };
export const radii = { sm: 8, md: 16, lg: 24, pill: 999 };
