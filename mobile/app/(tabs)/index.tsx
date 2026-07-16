import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Platform,
  Image,
  TextInput,
  Modal,
  ActivityIndicator,
  Alert,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { useSettings } from '../../hooks/useSettings';
import { useCamera } from '../../hooks/useCamera';
import { useAuth } from '../../hooks/useAuth';
import { getApiBaseUrl } from '../../lib/api';


export default function HomeScreen() {
  const router = useRouter();
  const { t, profile, updateProfile, notificationsEnabled, sharedLocation, setSharedLocation } = useSettings();
  const { takePhoto, isProcessing } = useCamera();
  const { user, token, updateUser } = useAuth();

  const [briefs, setBriefs] = useState<any[]>([]);
  const [loadingBriefs, setLoadingBriefs] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [notificationCount, setNotificationCount] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const apiUrl = `${getApiBaseUrl()}/briefs`;
        console.log("Fetching from:", apiUrl);
        const response = await fetch(apiUrl);
        const data = await response.json();
        if (data.status === 'ok' && data.briefs) {
          setBriefs(data.briefs);
        } else {
          throw new Error("Invalid data from server");
        }
      } catch (error: any) {
        console.warn("Backend not reachable, using local mock data for briefs");
        const mockBriefs = [
          {
            id: '1',
            title: 'New Expressway Speed Limits',
            desc: 'The NHAI has updated the speed limits for LMVs to 120 kmph on major expressways starting this month.',
            icon: 'speedometer',
            iconBg: '#ffedd5',
            iconColor: '#c2410c'
          },
          {
            id: '2',
            title: 'Digital RC & License Valid',
            desc: 'Traffic police across states are now mandated to accept digital documents stored in DigiLocker or mParivahan.',
            icon: 'cellphone-check',
            iconBg: '#dcfce7',
            iconColor: '#15803d'
          },
          {
            id: '3',
            title: 'E-Challan Grace Period Extended',
            desc: 'Vehicle owners now have up to 45 days to dispute an e-challan through the virtual traffic courts.',
            icon: 'gavel',
            iconBg: '#f3e8ff',
            iconColor: '#7e22ce'
          }
        ];
        setBriefs(mockBriefs);
        setErrorMsg(null);
      } finally {
        setLoadingBriefs(false);
      }
    })();
  }, []);

  // Fetch live notification count for bell badge
  useEffect(() => {
    (async () => {
      try {
        const params = new URLSearchParams();
        if (sharedLocation.zoneType) params.set('zone_type', sharedLocation.zoneType);
        const res = await fetch(`${getApiBaseUrl()}/notifications?${params.toString()}`, {
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.status === 'ok' && Array.isArray(data.notifications)) {
            // Import AsyncStorage lazily to check cleared list
            const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
            const clearedRaw = await AsyncStorage.getItem('@drivelegal_cleared_notifications');
            const cleared: string[] = clearedRaw ? JSON.parse(clearedRaw) : [];
            const visible = data.notifications.filter((n: any) => !cleared.includes(n.id));
            setNotificationCount(visible.length);
          }
        }
      } catch (e) {
        // Badge count fetch failing is non-critical — keep previous count
      }
    })();
  }, [sharedLocation.zoneType]);
  const [address, setAddress] = useState('Fetching Location...');
  const [region, setRegion] = useState('Locating...');
  const [greetingTime, setGreetingTime] = useState('GOOD MORNING');

  useEffect(() => {
    const hour = new Date().getHours();
    if (hour < 12) setGreetingTime('GOOD MORNING');
    else if (hour < 17) setGreetingTime('GOOD AFTERNOON');
    else if (hour < 21) setGreetingTime('GOOD EVENING');
    else setGreetingTime('HII LATE OWL');
  }, []);

  useEffect(() => {
    (async () => {
      try {
        let { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          setAddress(t('location_denied') || 'Location Access Denied');
          setRegion(t('please_enable_gps') || 'Please enable GPS');
          return;
        }

        let loc;
        if (Platform.OS === 'web') {
          // On web, try with a short timeout, and fallback to Chennai if it takes too long or fails
          try {
            loc = await Promise.race([
              Location.getCurrentPositionAsync({}),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))
            ]) as any;
          } catch (e) {
            loc = {
              coords: {
                latitude: 13.0827,
                longitude: 80.2707,
                accuracy: 10,
                altitude: null,
                altitudeAccuracy: null,
                heading: null,
                speed: null,
              },
              timestamp: Date.now(),
            };
          }
        } else {
          loc = await Location.getCurrentPositionAsync({});
        }

        let placeName = 'Unknown Location';
        let regionName = 'Tamil Nadu';
        try {
          if (Platform.OS === 'web') {
            const res = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${loc.coords.latitude}&longitude=${loc.coords.longitude}&localityLanguage=en`);
            const data = await res.json();
            placeName = data.city || data.locality || 'Unknown Location';
            regionName = data.principalSubdivision || 'Tamil Nadu';
          } else {
            let geocode = await Location.reverseGeocodeAsync(loc.coords);
            if (geocode.length > 0) {
              const place = geocode[0];
              placeName = [place.street, place.city].filter(Boolean).join(', ') || 'Unknown Location';
              regionName = place.region || 'Tamil Nadu';
            }
          }
        } catch (geoErr) {
          console.warn("Reverse geocoding failed, using coordinates instead:", geoErr);
          placeName = `Lat: ${loc.coords.latitude.toFixed(2)}, Lon: ${loc.coords.longitude.toFixed(2)}`;
        }
        setAddress(placeName);
        setRegion(regionName);
        let pNameLower = placeName.toLowerCase();
        let speedLimit: number | null = 50;
        let zoneType = 'general';

        // IIT Madras campus geofence (matches backend/data/zones/TN/iit_madras_campus.geojson)
        const IITM_CAMPUS_BOUNDS = { minLat: 12.9850, maxLat: 13.0100, minLon: 80.2230, maxLon: 80.2500 };
        const inIitmCampus =
          loc.coords.latitude >= IITM_CAMPUS_BOUNDS.minLat &&
          loc.coords.latitude <= IITM_CAMPUS_BOUNDS.maxLat &&
          loc.coords.longitude >= IITM_CAMPUS_BOUNDS.minLon &&
          loc.coords.longitude <= IITM_CAMPUS_BOUNDS.maxLon;

        if (inIitmCampus) {
          speedLimit = 20;
          zoneType = 'campus_zone';
        } else if (pNameLower.includes('school') || pNameLower.includes('college') || pNameLower.includes('academy')) {
          speedLimit = 30;
          zoneType = 'school_zone';
        } else if (pNameLower.includes('iit') || pNameLower.includes('campus') || pNameLower.includes('university') || pNameLower.includes('institute')) {
          speedLimit = 20;
          zoneType = 'campus_zone';
        } else if (pNameLower.includes('hospital') || pNameLower.includes('clinic')) {
          speedLimit = 30;
          zoneType = 'hospital_zone';
        } else if (pNameLower.includes('express') || pNameLower.includes('highway') || pNameLower.includes('bypass')) {
          speedLimit = 80;
          zoneType = 'general';
        } else {
          // Dynamic deterministic fallback based on coordinates for testing
          const hash = Math.floor(Math.abs(loc.coords.latitude * loc.coords.longitude) * 10000) % 5;
          const limits = [40, 50, 60, 45, 55];
          speedLimit = limits[hash];
        }

        setSharedLocation(prev => ({
          ...prev,
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
          placeName,
          regionName,
          speedLimit,
          zoneType,
        }));
      } catch (e) {
        console.warn("Location permission or fetching failed:", e);
        setAddress('Chennai');
        setRegion('Tamil Nadu');
        setSharedLocation(prev => ({
          ...prev,
          latitude: 13.0827,
          longitude: 80.2707,
          placeName: 'Chennai',
          regionName: 'Tamil Nadu',
        }));
      }
    })();
  }, []);

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        
        {/* Header */}
        <View style={styles.header}>
          <View style={[styles.headerLeft, { flex: 1, paddingRight: 12 }]}>
            <View style={styles.logoContainer}>
              <Text style={styles.logoText}>DL</Text>
            </View>
            <Text style={[styles.greeting, { flexShrink: 1 }]} numberOfLines={1} ellipsizeMode="tail">
              {greetingTime}, {(user?.name || profile.name).toUpperCase()}
            </Text>
          </View>
          <View style={styles.headerRight}>


            <TouchableOpacity style={styles.notificationBtn} onPress={() => router.push('/notifications')}>
              <Ionicons name="notifications-outline" size={22} color="#1c1c1c" />
              {notificationsEnabled && notificationCount > 0 && (
                <View style={styles.notificationBadge}>
                  <Text style={styles.notificationBadgeText}>
                    {notificationCount > 9 ? '9+' : String(notificationCount)}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          </View>
        </View>

        {/* Location Card */}
        <View style={styles.locationCard}>
          <View style={styles.locationHeader}>
            <Ionicons name="location-outline" size={16} color="#d97706" />
            <Text style={styles.locationLabel}>{t('location_label')}</Text>
          </View>
          <Text style={styles.locationTitle}>{sharedLocation.placeName}</Text>
          <Text style={styles.locationSubtitle}>{sharedLocation.regionName} • Live GPS Context</Text>
          
          <View style={styles.pillsRow}>
            <View style={styles.pill}>
              <Text style={styles.pillLabel}>{t('speed')}</Text>
              <Text style={styles.pillValueOrange}>
                {sharedLocation.speedLimit || 'General'}{' '}
                {sharedLocation.speedLimit && <Text style={styles.pillUnitOrange}>kmph</Text>}
              </Text>
            </View>
            <View style={[styles.pill, sharedLocation.zoneType !== 'general' ? { backgroundColor: '#3f1d1d' } : {}]}>
              <Text style={[styles.pillLabel, sharedLocation.zoneType !== 'general' ? { color: '#fca5a5' } : {}]}>{t('fine_zone')}</Text>
              <Text style={[styles.pillValue, sharedLocation.zoneType !== 'general' ? { color: '#ef4444' } : {}]}>
                {sharedLocation.zoneType === 'general' ? 'None' : sharedLocation.zoneType.replace('_', ' ').toUpperCase()}
              </Text>
            </View>
          </View>
        </View>

        {/* SOS Emergency Card (Prominent) */}
        <TouchableOpacity 
          style={styles.sosCard}
          onPress={() => router.push('/sos')}
        >
          <View style={styles.sosContent}>
            <View style={styles.sosIconContainer}>
              <Ionicons name="warning" size={24} color="#ef4444" />
            </View>
            <View style={styles.sosTextContainer}>
              <Text style={styles.sosTitle}>{t('sos_title')}</Text>
              <Text style={styles.sosSubtitle}>{t('sos_subtitle')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#fca5a5" />
          </View>
        </TouchableOpacity>

        {/* Action Grid */}
        <View style={styles.gridContainer}>
          <View style={styles.gridRow}>
            <TouchableOpacity 
              style={[styles.gridItem, styles.askItem]} 
              onPress={() => router.push('/(tabs)/ask')}
            >
              <View style={styles.iconContainerWhite}>
                <Ionicons name="chatbubble-ellipses-outline" size={20} color="#fff" />
              </View>
              <Text style={styles.askItemTitle}>{t('ask_title')}</Text>
              <Text style={styles.askItemSubtitle}>{t('ask_subtitle')}</Text>
            </TouchableOpacity>
            
            <TouchableOpacity style={styles.gridItem} onPress={() => router.push('/(tabs)/fines')}>
              <View style={styles.iconContainerBrown}>
                <Ionicons name="document-text-outline" size={20} color="#d97706" />
              </View>
              <Text style={styles.gridItemTitle}>{t('challan_title')}</Text>
              <Text style={styles.gridItemSubtitle}>{t('challan_subtitle')}</Text>
            </TouchableOpacity>
          </View>
          
          <View style={styles.gridRow}>
            <TouchableOpacity style={styles.gridItem} onPress={() => router.push('/settings/documents')}>
              <View style={styles.iconContainerBrown}>
                <Ionicons name="folder-outline" size={20} color="#d97706" />
              </View>
              <Text style={styles.gridItemTitle}>{t('vault_title')}</Text>
              <Text style={styles.gridItemSubtitle}>{t('vault_subtitle')}</Text>
            </TouchableOpacity>
            
            <TouchableOpacity style={styles.gridItem} onPress={() => router.push('/(tabs)/report')}>
              <View style={[styles.iconContainerBrown, { backgroundColor: '#f3e8ff' }]}>
                <Ionicons name="megaphone-outline" size={20} color="#a855f7" />
              </View>
              <Text style={styles.gridItemTitle}>{t('report_title')}</Text>
              <Text style={styles.gridItemSubtitle}>{t('report_subtitle')}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Today's Brief */}
        <View style={styles.briefHeader}>
          <Text style={styles.briefTitle}>{t('todays_brief')}</Text>
          <TouchableOpacity>
            <Text style={styles.seeAllText}>{t('see_all')}</Text>
          </TouchableOpacity>
        </View>

        {loadingBriefs ? (
          <ActivityIndicator size="small" color="#d97706" style={{ marginTop: 20 }} />
        ) : briefs.length > 0 ? (
          briefs.map((item) => (
            <TouchableOpacity 
              key={item.id} 
              style={styles.briefCard}
              onPress={() => item.link ? Linking.openURL(item.link).catch(err => console.warn('Cannot open URL', err)) : null}
            >
              <View style={[styles.briefIconContainer, { backgroundColor: item.iconBg || '#fef3c7' }]}>
                <MaterialCommunityIcons name={(item.icon as any) || 'newspaper'} size={20} color={item.iconColor || '#d97706'} />
              </View>
              <View style={styles.briefContent}>
                <Text style={styles.briefCardTitle}>{item.title}</Text>
                <Text style={styles.briefCardDesc}>{item.desc}</Text>
              </View>
            </TouchableOpacity>
          ))
        ) : errorMsg ? (
          <Text style={{ textAlign: 'center', color: '#ef4444', marginTop: 20 }}>Error: {errorMsg}</Text>
        ) : (
          <Text style={{ textAlign: 'center', color: '#6b7280', marginTop: 20 }}>No briefs available today.</Text>
        )}
        
      </ScrollView>



    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#FAF8F5',
  },
  container: {
    flex: 1,
    backgroundColor: '#FAF8F5',
  },
  content: {
    padding: 20,
    paddingBottom: 40,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  logoContainer: {
    width: 32,
    height: 32,
    backgroundColor: '#1c1c1c',
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  logoText: {
    color: '#d97706',
    fontWeight: 'bold',
    fontSize: 14,
  },
  greeting: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6b7280',
    letterSpacing: 0.5,
  },
  notificationBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#f3f0ea',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  notificationDot: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#ef4444',
    borderWidth: 1,
    borderColor: '#f3f0ea',
  },
  notificationBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#ef4444',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
    borderWidth: 1,
    borderColor: '#f3f0ea',
  },
  notificationBadgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
  },
  locationCard: {
    backgroundColor: '#1c1c1c',
    borderRadius: 24,
    padding: 20,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.1,
    shadowRadius: 15,
    elevation: 5,
  },
  locationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  locationLabel: {
    color: '#9ca3af',
    fontSize: 12,
    fontWeight: '600',
    marginLeft: 6,
  },
  locationTitle: {
    color: '#fff',
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  locationSubtitle: {
    color: '#9ca3af',
    fontSize: 13,
    marginBottom: 20,
  },
  pillsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  pill: {
    flex: 1,
    backgroundColor: '#2e2e2e',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  pillLabel: {
    color: '#9ca3af',
    fontSize: 10,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  pillValue: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 'bold',
  },
  pillValueOrange: {
    color: '#d97706',
    fontSize: 14,
    fontWeight: 'bold',
  },
  pillUnitOrange: {
    fontSize: 11,
    fontWeight: 'normal',
  },
  sosCard: {
    backgroundColor: '#fef2f2',
    borderRadius: 20,
    marginBottom: 24,
    shadowColor: '#ef4444',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
    elevation: 3,
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  sosContent: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 20,
  },
  sosIconContainer: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#fee2e2',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  sosTextContainer: {
    flex: 1,
  },
  sosTitle: {
    fontSize: 17,
    fontWeight: 'bold',
    color: '#991b1b',
    marginBottom: 4,
  },
  sosSubtitle: {
    fontSize: 13,
    color: '#ef4444',
  },
  gridContainer: {
    gap: 12,
    marginBottom: 24,
  },
  gridRow: {
    flexDirection: 'row',
    gap: 12,
  },
  gridItem: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  askItem: {
    backgroundColor: '#d97706',
  },
  iconContainerWhite: {
    width: 40,
    height: 40,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  iconContainerBrown: {
    width: 40,
    height: 40,
    backgroundColor: '#fef3c7',
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  askItemTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  askItemSubtitle: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 12,
  },
  gridItemTitle: {
    color: '#1c1c1c',
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  gridItemSubtitle: {
    color: '#6b7280',
    fontSize: 12,
  },
  briefHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  briefTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1c1c1c',
  },
  seeAllText: {
    color: '#b45309',
    fontSize: 14,
    fontWeight: '600',
  },
  briefCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    flexDirection: 'row',
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  briefIconContainer: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  briefContent: {
    flex: 1,
  },
  briefCardTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#1c1c1c',
    marginBottom: 4,
  },
  briefCardDesc: {
    fontSize: 13,
    color: '#4b5563',
    lineHeight: 18,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusDot: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#f3f0ea',
  },
  popoverOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
  },
  popoverContainer: {
    marginTop: Platform.OS === 'ios' ? 100 : 70,
    marginRight: 20,
    width: 290,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.25,
    shadowRadius: 15,
    elevation: 10,
  },
  popoverContent: {
    backgroundColor: '#1C1C1C',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#2D2D2D',
  },
  popoverHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  popoverTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#F9FAFB',
  },
  popoverSub: {
    fontSize: 11,
    color: '#9CA3AF',
    marginBottom: 12,
    lineHeight: 15,
  },
  popoverInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#111111',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2D2D2D',
    paddingHorizontal: 12,
    height: 40,
  },
  popoverInputIcon: {
    marginRight: 8,
  },
  popoverInput: {
    flex: 1,
    color: '#F3F4F6',
    fontSize: 14,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as any,
  },

  popoverSaveBtn: {
    backgroundColor: '#B91C1C',
    borderRadius: 12,
    height: 40,
    width: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 12,
  },
  popoverSaveText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
  },
});
