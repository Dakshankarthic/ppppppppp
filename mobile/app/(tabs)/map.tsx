import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, Text, ActivityIndicator, Platform, ScrollView, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MapView, { Polygon, Region, Marker } from 'react-native-maps';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import { getApiBaseUrl } from '../../lib/api';
import { useSettings } from '../../hooks/useSettings';
import { useLocalSearchParams } from 'expo-router';
import iitmPoisData from '../../lib/data/iitmPois.json';

const BACKEND_URL = getApiBaseUrl();

interface Zone {
  id: string;
  type: string;
  speedLimit: number | null;
  coordinates: { latitude: number; longitude: number }[];
  activeRules: string;
}

interface POI {
  id: string;
  name: string;
  type: 'school' | 'hospital' | 'petrol' | 'mechanic';
  latitude: number;
  longitude: number;
  address: string;
}

// Real schools, hospitals, fuel stations, and mechanic sheds within ~40km of
// IIT Madras (12.9915, 80.2337), sourced from OpenStreetMap (see lib/data/iitmPois.json).
const POIS: POI[] = iitmPoisData as POI[];

export default function MapScreen() {
  const { t, setSharedLocation } = useSettings();
  const { poiFilter } = useLocalSearchParams<{ poiFilter: string }>();
  const insets = useSafeAreaInsets();
  const [location, setLocation] = useState<Location.LocationObject | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [activeZone, setActiveZone] = useState<Zone | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeFilters, setActiveFilters] = useState<string[]>([]);

  const mapRef = useRef<MapView>(null);

  useEffect(() => {
    if (poiFilter) {
      setActiveFilters(poiFilter.split(','));
    }
  }, [poiFilter]);

  useEffect(() => {
    (async () => {
      try {
        let { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          setErrorMsg('Permission to access location was denied');
          return;
        }

        let loc;
        if (Platform.OS === 'web') {
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
        setLocation(loc);
      } catch (e) {
        console.warn("Location permission or fetching failed in map:", e);
        setLocation({
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
        });
      }

      // Fetch zones from backend
      try {
        const response = await fetch(`${BACKEND_URL}/sync/zones?states=TN`);
        const data = await response.json();

        if (data && data.features) {
          const parsedZones: Zone[] = data.features.map((f: any, index: number) => {
            let coords = [];
            if (f.geometry.type === 'Polygon' && f.geometry.coordinates[0]) {
              coords = f.geometry.coordinates[0].map((coord: number[]) => ({
                latitude: coord[1],
                longitude: coord[0]
              }));
            }
            return {
              id: f.properties.zone_id || `zone_${index}`,
              type: f.properties.zone_type || 'unknown',
              speedLimit: f.properties.speed_limit_kmh || null,
              coordinates: coords,
              activeRules: f.properties.active_hours ? `Active Hours: ${f.properties.active_hours}` : 'All Rules Active'
            };
          });
          setZones(parsedZones);
        }
      } catch (err) {
        console.error("Error fetching zones:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const getZoneColor = (type: string) => {
    switch (type) {
      case 'school_zone': return 'rgba(255, 204, 0, 0.4)';
      case 'no_horn': return 'rgba(255, 59, 48, 0.4)';
      case 'speed_limit': return 'rgba(0, 122, 255, 0.4)';
      default: return 'rgba(142, 142, 147, 0.4)';
    }
  };

  const getZoneStroke = (type: string) => {
    switch (type) {
      case 'school_zone': return '#FFCC00';
      case 'no_horn': return '#FF3B30';
      case 'speed_limit': return '#007AFF';
      default: return '#8E8E93';
    }
  };

  const handleRegionChange = async (region: Region) => {
    const center = { lat: region.latitude, lon: region.longitude };

    let found = null;
    for (const zone of zones) {
      if (zone.coordinates.length > 0) {
        const lats = zone.coordinates.map(c => c.latitude);
        const lons = zone.coordinates.map(c => c.longitude);
        const minLat = Math.min(...lats);
        const maxLat = Math.max(...lats);
        const minLon = Math.min(...lons);
        const maxLon = Math.max(...lons);

        if (center.lat >= minLat && center.lat <= maxLat && center.lon >= minLon && center.lon <= maxLon) {
          let isInside = false;
          const x = center.lat;
          const y = center.lon;
          const poly = zone.coordinates;
          for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const xi = poly[i].latitude, yi = poly[i].longitude;
            const xj = poly[j].latitude, yj = poly[j].longitude;
            const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
            if (intersect) isInside = !isInside;
          }
          if (isInside) {
            found = zone;
            break;
          }
        }
      }
    }
    setActiveZone(found);

    // Geocode the center coordinates to update context
    let placeName = 'Chennai';
    let regionName = 'Tamil Nadu';
    try {
      if (Platform.OS === 'web') {
        const res = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${region.latitude}&longitude=${region.longitude}&localityLanguage=en`);
        const data = await res.json();
        placeName = data.city || data.locality || 'Unknown Location';
        regionName = data.principalSubdivision || 'Tamil Nadu';
      } else {
        const geocode = await Location.reverseGeocodeAsync({
          latitude: region.latitude,
          longitude: region.longitude
        });
        if (geocode && geocode.length > 0) {
          const place = geocode[0];
          placeName = [place.street, place.city].filter(Boolean).join(', ') || 'Chennai';
          regionName = place.region || 'Tamil Nadu';
        }
      }
    } catch (err) {
      console.log("Geocoding failed on map region change:", err);
    }

    setSharedLocation(prev => ({
      ...prev,
      latitude: location?.coords.latitude ?? 0,
      longitude: location?.coords.longitude ?? 0,
      speedLimit: found ? found.speedLimit : 50,
      zoneType: found ? found.type : 'general',
      helmetRequired: true,
      placeName,
      regionName
    }));
  };

  const toggleFilter = (filter: string) => {
    setActiveFilters(prev =>
      prev.includes(filter) ? prev.filter(f => f !== filter) : [...prev, filter]
    );
  };

  if (loading || !location) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#d97706" />
        <Text style={styles.loadingText}>Loading Map & Geofences...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>

      {/* POI Filters Header */}
      <View style={[styles.filterContainer, { top: insets.top + 10 }]}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterScroll}
        >
          {['Schools', 'Hospitals', 'Petrol Pumps', 'Mechanic Sheds'].map((filter) => {
            const isSelected = activeFilters.includes(filter);
            let iconName = 'school-outline';
            let iconColor = '#d97706';
            if (filter === 'Hospitals') { iconName = 'medical-outline'; iconColor = '#ef4444'; }
            else if (filter === 'Petrol Pumps') { iconName = 'funnel-outline'; iconColor = '#0284c7'; }
            else if (filter === 'Mechanic Sheds') { iconName = 'construct-outline'; iconColor = '#16a34a'; }

            return (
              <TouchableOpacity
                key={filter}
                style={[
                  styles.filterButton,
                  isSelected && { backgroundColor: iconColor, borderColor: iconColor }
                ]}
                onPress={() => toggleFilter(filter)}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={iconName as any}
                  size={16}
                  color={isSelected ? '#fff' : iconColor}
                  style={{ marginRight: 6 }}
                />
                <Text style={[
                  styles.filterText,
                  isSelected && { color: '#fff', fontWeight: '700' }
                ]}>
                  {filter === 'Schools' ? t('schools') : filter === 'Hospitals' ? t('hospitals') : filter === 'Petrol Pumps' ? t('petrol_pumps') : t('mechanic_sheds')}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={{
          latitude: location.coords.latitude,
          longitude: location.coords.longitude,
          latitudeDelta: 0.0922,
          longitudeDelta: 0.0421,
        }}
        showsUserLocation={true}
        onRegionChangeComplete={handleRegionChange}
      >
        {zones.map(zone => (
          zone.coordinates.length > 0 ? (
            <Polygon
              key={zone.id}
              coordinates={zone.coordinates}
              fillColor={getZoneColor(zone.type)}
              strokeColor={getZoneStroke(zone.type)}
              strokeWidth={2}
            />
          ) : null
        ))}

        {/* POI Markers Rendering */}
        {POIS.map(poi => {
          const filterName = poi.type === 'school' ? 'Schools' : poi.type === 'hospital' ? 'Hospitals' : poi.type === 'petrol' ? 'Petrol Pumps' : 'Mechanic Sheds';
          const isEnabled = activeFilters.includes(filterName);
          if (!isEnabled) return null;

          let pinCol: 'orange' | 'red' | 'blue' | 'green' = 'orange';
          if (poi.type === 'hospital') pinCol = 'red';
          else if (poi.type === 'petrol') pinCol = 'blue';
          else if (poi.type === 'mechanic') pinCol = 'green';

          return (
            <Marker
              key={poi.id}
              coordinate={{ latitude: poi.latitude, longitude: poi.longitude }}
              title={poi.name}
              description={poi.address}
              pinColor={pinCol}
              tracksViewChanges={false}
            />
          );
        })}
      </MapView>

      {/* Dynamic Rule Panel */}
      <View style={[styles.panel, { bottom: insets.bottom + 20 }]}>
        {activeZone ? (
          <>
            <Text style={styles.zoneTitle}>
              {activeZone.type.replace('_', ' ').toUpperCase()}
            </Text>
            {activeZone.speedLimit && (
              <Text style={styles.speedLimit}>Limit: {activeZone.speedLimit} km/h</Text>
            )}
            <Text style={styles.rules}>{activeZone.activeRules}</Text>
          </>
        ) : (
          <Text style={styles.zoneTitle}>{t('general_driving_zone')}</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    position: 'relative',
  },
  map: {
    width: '100%',
    height: '100%',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FAF8F5',
  },
  loadingText: {
    marginTop: 10,
    color: '#666',
  },
  filterContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 100,
  },
  filterScroll: {
    paddingHorizontal: 20,
    gap: 10,
  },
  filterButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  filterText: {
    fontSize: 13,
    color: '#374151',
    fontWeight: '500',
  },
  panel: {
    position: 'absolute',
    left: 20,
    right: 20,
    backgroundColor: 'white',
    padding: 20,
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    elevation: 5,
  },
  zoneTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
  },
  speedLimit: {
    fontSize: 16,
    color: '#d97706',
    fontWeight: '600',
    marginTop: 5,
  },
  rules: {
    fontSize: 14,
    color: '#666',
    marginTop: 5,
  },
});
