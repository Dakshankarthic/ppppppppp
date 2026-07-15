import React from 'react';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Platform, View, StyleSheet } from 'react-native';
import { useSettings } from '../../hooks/useSettings';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function TabLayout() {
  const { t } = useSettings();
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.container}>
      <Tabs
        screenOptions={{
          tabBarActiveTintColor: '#d97706',
          tabBarInactiveTintColor: '#9ca3af',
          tabBarHideOnKeyboard: true,
          tabBarStyle: {
            backgroundColor: '#fff',
            borderTopColor: '#e5e7eb',
            // Content box = height - paddingTop - paddingBottom must fit the
            // 24px icon + ~16px label. Give it ~54px of room so labels never clip.
            height: Platform.OS === 'ios' ? 84 + insets.bottom : 72 + insets.bottom,
            paddingBottom: Platform.OS === 'ios' ? insets.bottom + 6 : insets.bottom + 10,
            paddingTop: 8,
            elevation: 0,
            shadowOpacity: 0,
          },
          tabBarItemStyle: {
            justifyContent: 'center',
            alignItems: 'center',
            flex: 1,
          },
          headerShown: false,
          tabBarLabelStyle: {
            fontSize: 11,
            lineHeight: 14,
            marginTop: 2,
          },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: t('tab_home'),
            tabBarIcon: ({ color }) => (
              <View style={{ width: 24, height: 24, justifyContent: 'center', alignItems: 'center' }}>
                <Ionicons name="home-outline" size={24} color={color} />
              </View>
            ),
          }}
        />
        <Tabs.Screen
          name="ask"
          options={{
            title: t('tab_ask'),
            tabBarIcon: ({ color }) => (
              <View style={{ width: 24, height: 24, justifyContent: 'center', alignItems: 'center' }}>
                <Ionicons name="chatbubble-outline" size={24} color={color} />
              </View>
            ),
          }}
        />
        <Tabs.Screen
          name="fines"
          options={{
            title: 'Fines & Rules',
            tabBarIcon: ({ color }) => (
              <View style={{ width: 24, height: 24, justifyContent: 'center', alignItems: 'center' }}>
                <Ionicons name="document-text-outline" size={24} color={color} />
              </View>
            ),
          }}
        />
        <Tabs.Screen
          name="zones"
          options={{
            href: null,
            title: t('tab_rules'),
            tabBarIcon: ({ color }) => (
              <View style={{ width: 24, height: 24, justifyContent: 'center', alignItems: 'center' }}>
                <Ionicons name="book-outline" size={24} color={color} />
              </View>
            ),
          }}
        />
        <Tabs.Screen
          name="map"
          options={{
            title: t('tab_map'),
            tabBarIcon: ({ color }) => (
              <View style={{ width: 24, height: 24, justifyContent: 'center', alignItems: 'center' }}>
                <Ionicons name="map-outline" size={24} color={color} />
              </View>
            ),
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: t('tab_you'),
            tabBarIcon: ({ color }) => (
              <View style={{ width: 24, height: 24, justifyContent: 'center', alignItems: 'center' }}>
                <Ionicons name="person-outline" size={24} color={color} />
              </View>
            ),
          }}
        />
        
        {/* Hide tabs that aren't in the bottom bar */}
        <Tabs.Screen name="report" options={{ href: null }} />
      </Tabs>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FAF8F5',
  },
});
