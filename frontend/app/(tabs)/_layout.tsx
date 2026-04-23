import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../src/theme';
import { Platform } from 'react-native';

type IconProps = { color: string; size: number };

const HomeIcon = (p: IconProps) => <Ionicons name="shield" {...p} />;
const TasksIcon = (p: IconProps) => <Ionicons name="checkbox" {...p} />;
const GoalsIcon = (p: IconProps) => <Ionicons name="flag" {...p} />;
const ProgressIcon = (p: IconProps) => <Ionicons name="stats-chart" {...p} />;
const ProfileIcon = (p: IconProps) => <Ionicons name="person-circle" {...p} />;

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.green,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: Platform.OS === 'ios' ? 88 : 68,
          paddingBottom: Platform.OS === 'ios' ? 28 : 10,
          paddingTop: 8,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: 'Home', tabBarIcon: HomeIcon, tabBarButtonTestID: 'tab-home' }}
      />
      <Tabs.Screen
        name="tasks"
        options={{ title: 'Quests', tabBarIcon: TasksIcon, tabBarButtonTestID: 'tab-tasks' }}
      />
      <Tabs.Screen
        name="goals"
        options={{ title: 'Goals', tabBarIcon: GoalsIcon, tabBarButtonTestID: 'tab-goals' }}
      />
      <Tabs.Screen
        name="progress"
        options={{ title: 'Progress', tabBarIcon: ProgressIcon, tabBarButtonTestID: 'tab-progress' }}
      />
      <Tabs.Screen
        name="profile"
        options={{ title: 'Profile', tabBarIcon: ProfileIcon, tabBarButtonTestID: 'tab-profile' }}
      />
    </Tabs>
  );
}
