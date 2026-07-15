import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
  Image,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useCamera } from '../../hooks/useCamera';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getApiBaseUrl } from '../../lib/api';

const INCIDENT_TYPES = [
  { id: 'traffic', label: 'Traffic Violation', icon: 'car-sport' as const, color: '#F59E0B' },
  { id: 'accident', label: 'Accident', icon: 'warning' as const, color: '#EF4444' },
  { id: 'infrastructure', label: 'Pothole/Road', icon: 'construct' as const, color: '#8B5CF6' },
  { id: 'parking', label: 'Illegal Parking', icon: 'close-circle' as const, color: '#3B82F6' },
];

export default function ReportScreen() {
  const { imageUri, base64, takePhoto, pickFromGallery, clearImage, isProcessing } = useCamera();
  const [incidentType, setIncidentType] = useState<string | null>(null);
  const [vehicleNumber, setVehicleNumber] = useState('');
  const [locationText, setLocationText] = useState('');
  const [description, setDescription] = useState('');
  const [isLocating, setIsLocating] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [reportData, setReportData] = useState<any>(null);
  const [viewingHistory, setViewingHistory] = useState(false);
  const [historyData, setHistoryData] = useState<any[]>([]);
  
  const fadeAnim = useState(new Animated.Value(0))[0];

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 600,
      useNativeDriver: true,
    }).start();
  }, []);

  const handleNewReport = () => {
    clearImage();
    setIncidentType(null);
    setVehicleNumber('');
    setLocationText('');
    setDescription('');
    setReportData(null);
    setSubmitted(false);
  };

  const loadHistory = async () => {
    try {
      const existingStr = await AsyncStorage.getItem('reports_data');
      if (existingStr) {
        let reports = JSON.parse(existingStr);
        
        // Sync statuses with backend
        try {
          const ids = reports.map((r: any) => r.id);
          const apiUrl = getApiBaseUrl();
          const res = await fetch(`${apiUrl}/report/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ report_ids: ids })
          });
          if (res.ok) {
            const data = await res.json();
            if (data.statuses) {
              reports = reports.map((r: any) => ({
                ...r,
                status: data.statuses[r.id] || r.status
              }));
              await AsyncStorage.setItem('reports_data', JSON.stringify(reports));
            }
          }
        } catch (syncErr) {
          console.log('Error syncing statuses', syncErr);
        }
        
        setHistoryData(reports);
      }
    } catch (e) {
      console.log('Error loading history', e);
    }
  };

  const toggleHistory = () => {
    if (!viewingHistory) {
      loadHistory();
    }
    setViewingHistory(!viewingHistory);
  };

  const fetchLocation = async () => {
    setIsLocating(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        if (Platform.OS === 'web') {
          console.warn('Permission to access location was denied');
        } else {
          alert('Permission to access location was denied');
        }
        setIsLocating(false);
        return;
      }
      
      let location;
      if (Platform.OS === 'web') {
        try {
          location = await Promise.race([
            Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
          ]) as any;
        } catch (e) {
          location = {
            coords: {
              latitude: 13.0827,
              longitude: 80.2707,
            }
          };
        }
      } else {
        location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      }

      const geocode = await Location.reverseGeocodeAsync(location.coords);
      
      if (geocode && geocode.length > 0) {
        const place = geocode[0];
        setLocationText(`${place.name || place.street}, ${place.district || place.city}`);
      } else {
        setLocationText(`${location.coords.latitude.toFixed(4)}, ${location.coords.longitude.toFixed(4)}`);
      }
    } catch (e) {
      console.log('Location error', e);
      if (Platform.OS === 'web') {
        setLocationText('Chennai, Tamil Nadu');
      } else {
        alert('Could not fetch location.');
      }
    }
    setIsLocating(false);
  };

  const handleSubmit = async () => {
    if (!imageUri) {
      alert('Please upload an image as evidence.');
      return;
    }
    if (!incidentType) {
      alert('Please select an incident type.');
      return;
    }
    if (incidentType !== 'infrastructure' && !vehicleNumber) {
      alert('Please provide the vehicle number.');
      return;
    }
    if (!locationText) {
      alert('Please provide a location.');
      return;
    }
    
    // Generate Report Data
    const newReport = {
      id: `REP-${Math.floor(10000 + Math.random() * 90000)}`,
      type: incidentType,
      typeLabel: INCIDENT_TYPES.find(t => t.id === incidentType)?.label || 'Unknown',
      location: locationText,
      description,
      imageUri,
      timestamp: new Date().toISOString(),
      status: 'unverified'
    };

    // Attempt Server Sync
    let serverSynced = false;
    let fineAmount = 0;
    let ruleSection = 'N/A';
    
    try {
      const apiUrl = getApiBaseUrl();
      const response = await fetch(`${apiUrl}/report/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: newReport.id,
          type: newReport.type,
          typeLabel: newReport.typeLabel,
          location: newReport.location,
          description: newReport.description,
          vehicle_number: vehicleNumber,
          image_base64: base64 || '',
          timestamp: newReport.timestamp
        })
      });
      if (response.ok) {
        const result = await response.json();
        serverSynced = true;
        fineAmount = result.fine_amount || 0;
        ruleSection = result.rule_section || 'N/A';
      }
    } catch (e) {
      console.log('Server sync failed:', e);
      alert('Note: Server is unreachable. Report saved locally only.');
    }

    // Attach fetched fine data to the local save
    const finalReportData = {
      ...newReport,
      vehicleNumber,
      fineAmount,
      ruleSection
    };

    // Save locally
    try {
      const existingStr = await AsyncStorage.getItem('reports_data');
      const existing = existingStr ? JSON.parse(existingStr) : [];
      await AsyncStorage.setItem('reports_data', JSON.stringify([finalReportData, ...existing]));
    } catch (e) {
      console.log('Failed to save report', e);
    }
    
    setReportData(finalReportData);
    setSubmitted(true);
  };

  if (submitted && reportData) {
    const formattedDate = new Date(reportData.timestamp).toLocaleString();
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.historyHeader}>
          <TouchableOpacity onPress={() => setSubmitted(false)} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color="#F9FAFB" />
          </TouchableOpacity>
          <Text style={styles.historyHeaderTitle}>{viewingHistory ? 'My Reports' : 'Report Incident'}</Text>
        </View>
        <ScrollView contentContainerStyle={styles.sheetContainer}>
          <View style={styles.sheetPaper}>
            {/* Sheet Header (E-Challan Style) */}
            <View style={[styles.sheetHeader, { backgroundColor: '#F3F4F6' }]}>
              <Ionicons name="shield" size={40} color="#333" style={{ marginBottom: 8 }} />
              <Text style={styles.sheetBrand}>TAMIL NADU POLICE DEPARTMENT</Text>
              <Text style={[styles.sheetTitle, { color: '#DC2626' }]}>E-CHALLAN RECEIPT</Text>
            </View>

            {/* Sheet Details (Strict Grid) */}
            <View style={styles.sheetDetails}>
              <View style={styles.sheetRow}>
                <Text style={styles.sheetLabel}>E-Challan No:</Text>
                <Text style={[styles.sheetValue, { fontWeight: '800' }]}>{reportData.id}</Text>
              </View>
              <View style={styles.sheetRow}>
                <Text style={styles.sheetLabel}>Date & Time:</Text>
                <Text style={styles.sheetValue}>{formattedDate}</Text>
              </View>
              <View style={styles.sheetRow}>
                <Text style={styles.sheetLabel}>Vehicle No:</Text>
                <Text style={[styles.sheetValue, { fontWeight: '800' }]}>{reportData.vehicleNumber || 'N/A'}</Text>
              </View>
              <View style={styles.sheetRow}>
                <Text style={styles.sheetLabel}>Place of Offence:</Text>
                <Text style={styles.sheetValue}>{reportData.location}</Text>
              </View>
              <View style={styles.sheetRow}>
                <Text style={styles.sheetLabel}>Offence Type:</Text>
                <Text style={styles.sheetValue}>{reportData.typeLabel}</Text>
              </View>
              <View style={styles.sheetRow}>
                <Text style={styles.sheetLabel}>Violated Rule:</Text>
                <Text style={styles.sheetValue}>{reportData.ruleSection}</Text>
              </View>
              <View style={[styles.sheetRow, { backgroundColor: '#FEF2F2' }]}>
                <Text style={[styles.sheetLabel, { color: '#DC2626', fontWeight: '900' }]}>Total Fine:</Text>
                <Text style={[styles.sheetValue, { fontSize: 16, color: '#DC2626', fontWeight: '900' }]}>₹ {reportData.fineAmount}</Text>
              </View>
            </View>

            {/* Evidence Image */}
            <Text style={styles.sheetLabel}>Evidence Attached:</Text>
            <View style={styles.sheetEvidence}>
              <Image source={{ uri: reportData.imageUri }} style={styles.sheetImage} />
            </View>

            {/* Verification Signature Box */}
            <View style={styles.signatureBox}>
              <View style={styles.signatureHeader}>
                <Text style={styles.signatureTitle}>AUTHORITY VERIFICATION</Text>
              </View>
              <View style={styles.signatureContent}>
                {reportData.status === 'verified' ? (
                  <Ionicons name="checkmark-circle" size={40} color="#10B981" />
                ) : (
                  <View style={styles.unverifiedMark}>
                    <Ionicons name="close" size={32} color="#EF4444" />
                  </View>
                )}
                <Text style={styles.signatureStatus}>
                  {reportData.status === 'verified' ? 'VERIFIED' : 'PENDING REVIEW'}
                </Text>
              </View>
              <Text style={styles.signatureNote}>
                {reportData.status === 'verified' 
                  ? 'This report has been reviewed and validated by local authorities.' 
                  : 'This report is currently under review by local enforcement authorities.'}
              </Text>
            </View>
          </View>

          <TouchableOpacity style={styles.newReportBtn} onPress={handleNewReport}>
            <Text style={styles.newReportBtnText}>File Another Report</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (viewingHistory) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.historyHeader}>
          <TouchableOpacity onPress={toggleHistory} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color="#F9FAFB" />
          </TouchableOpacity>
          <Text style={styles.historyHeaderTitle}>My Reports</Text>
        </View>
        
        <ScrollView contentContainerStyle={styles.historyScroll}>
          {historyData.length === 0 ? (
            <Text style={styles.noHistoryText}>No reports filed yet.</Text>
          ) : (
            historyData.map(report => (
              <TouchableOpacity 
                key={report.id} 
                style={styles.historyCard}
                onPress={() => {
                  setReportData(report);
                  setSubmitted(true);
                }}
              >
                <View style={styles.historyCardHeader}>
                  <Text style={styles.historyCardId}>{report.id}</Text>
                  <Text style={styles.historyCardDate}>{new Date(report.timestamp).toLocaleDateString()}</Text>
                </View>
                <Text style={styles.historyCardType}>{report.typeLabel}</Text>
                <Text style={styles.historyCardLocation} numberOfLines={1}>{report.location}</Text>
                
                <View style={[styles.historyStatusBadge, report.status === 'verified' ? styles.statusVerified : styles.statusPending]}>
                  <Text style={[styles.historyStatusText, report.status === 'verified' ? styles.statusVerifiedText : styles.statusPendingText]}>
                    {report.status === 'verified' ? 'VERIFIED' : 'PENDING'}
                  </Text>
                </View>
              </TouchableOpacity>
            ))
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <KeyboardAvoidingView 
        style={{ flex: 1 }} 
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView 
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <Animated.View style={{ opacity: fadeAnim, transform: [{ translateY: fadeAnim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) }] }}>
            
            <View style={styles.headerRow}>
              <View style={styles.header}>
                <View style={styles.headerIconBg}>
                  <Ionicons name="shield-checkmark" size={24} color="#A855F7" />
                </View>
                <View>
                  <Text style={styles.headerTitle}>Report Incident</Text>
                  <Text style={styles.headerSubtitle}>File a direct report to authorities</Text>
                </View>
              </View>
              <TouchableOpacity style={styles.historyBtn} onPress={toggleHistory}>
                <Ionicons name="time" size={24} color="#A855F7" />
              </TouchableOpacity>
            </View>

            {/* IMAGE UPLOAD SECTION */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Evidence <Text style={styles.required}>*</Text></Text>
              
              {imageUri ? (
                <View style={styles.imagePreviewContainer}>
                  <Image source={{ uri: imageUri }} style={styles.previewImage} />
                  <TouchableOpacity style={styles.retakeBtn} onPress={clearImage}>
                    <Ionicons name="close-circle" size={30} color="#fff" />
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={styles.uploadRow}>
                  <TouchableOpacity style={styles.uploadBox} onPress={takePhoto} disabled={isProcessing}>
                    <Ionicons name="camera" size={32} color="#A855F7" />
                    <Text style={styles.uploadText}>Take Photo</Text>
                  </TouchableOpacity>
                  
                  <TouchableOpacity style={styles.uploadBox} onPress={pickFromGallery} disabled={isProcessing}>
                    <Ionicons name="images" size={32} color="#A855F7" />
                    <Text style={styles.uploadText}>Gallery</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>

            {/* INCIDENT TYPE */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Crime / Incident Type <Text style={styles.required}>*</Text></Text>
              <View style={styles.typeGrid}>
                {INCIDENT_TYPES.map(type => {
                  const isSelected = incidentType === type.id;
                  return (
                    <TouchableOpacity 
                      key={type.id} 
                      style={[
                        styles.typeCard, 
                        isSelected && { borderColor: type.color, backgroundColor: `${type.color}15` }
                      ]}
                      onPress={() => setIncidentType(type.id)}
                    >
                      <Ionicons name={type.icon} size={24} color={isSelected ? type.color : '#9CA3AF'} />
                      <Text style={[styles.typeText, isSelected && { color: type.color, fontWeight: '700' }]}>
                        {type.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {/* VEHICLE NUMBER */}
            {incidentType !== 'infrastructure' && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Vehicle Number <Text style={styles.required}>*</Text></Text>
                <View style={styles.inputWrapper}>
                  <Ionicons name="car" size={20} color="#6B7280" style={styles.inputIcon} />
                  <TextInput
                    style={styles.input}
                    placeholder="e.g. TN-01-AB-1234"
                    placeholderTextColor="#6B7280"
                    value={vehicleNumber}
                    onChangeText={setVehicleNumber}
                    autoCapitalize="characters"
                  />
                </View>
              </View>
            )}

            {/* LOCATION */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Location <Text style={styles.required}>*</Text></Text>
              <View style={styles.inputWrapper}>
                <Ionicons name="location" size={20} color="#6B7280" style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder="Street name or landmark"
                  placeholderTextColor="#6B7280"
                  value={locationText}
                  onChangeText={setLocationText}
                />
                <TouchableOpacity style={styles.locateBtn} onPress={fetchLocation} disabled={isLocating}>
                  {isLocating ? (
                    <ActivityIndicator size="small" color="#A855F7" />
                  ) : (
                    <Ionicons name="navigate-circle" size={26} color="#A855F7" />
                  )}
                </TouchableOpacity>
              </View>
            </View>

            {/* DESCRIPTION */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Description</Text>
              <View style={[styles.inputWrapper, { alignItems: 'flex-start' }]}>
                <TextInput
                  style={[styles.input, styles.textArea]}
                  placeholder="Additional details, vehicle numbers, etc."
                  placeholderTextColor="#6B7280"
                  value={description}
                  onChangeText={setDescription}
                  multiline
                  textAlignVertical="top"
                />
              </View>
            </View>

            {/* SUBMIT */}
            <TouchableOpacity style={styles.submitBtn} onPress={handleSubmit}>
              <Text style={styles.submitBtnText}>Submit Report</Text>
              <Ionicons name="paper-plane" size={20} color="#fff" style={{ marginLeft: 8 }} />
            </TouchableOpacity>

            <View style={{ height: 40 }} />
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#111111',
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 40,
  },
  
  // Header
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 32,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  historyBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(168, 85, 247, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerIconBg: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: 'rgba(168, 85, 247, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(168, 85, 247, 0.3)',
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: '#F9FAFB',
  },
  headerSubtitle: {
    fontSize: 13,
    color: '#9CA3AF',
    marginTop: 2,
  },

  section: {
    marginBottom: 28,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#E5E7EB',
    marginBottom: 12,
  },
  required: {
    color: '#EF4444',
  },

  // Upload
  uploadRow: {
    flexDirection: 'row',
    gap: 12,
  },
  uploadBox: {
    flex: 1,
    height: 120,
    borderWidth: 2,
    borderColor: '#2D2D2D',
    borderStyle: 'dashed',
    borderRadius: 16,
    backgroundColor: '#1A1A1A',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  uploadText: {
    color: '#9CA3AF',
    fontSize: 14,
    fontWeight: '600',
  },
  imagePreviewContainer: {
    width: '100%',
    height: 220,
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#2D2D2D',
  },
  previewImage: {
    width: '100%',
    height: '100%',
  },
  retakeBtn: {
    position: 'absolute',
    top: 12,
    right: 12,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 20,
    padding: 2,
  },

  // Incident Types
  typeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  typeCard: {
    width: '48%',
    backgroundColor: '#1A1A1A',
    borderWidth: 1,
    borderColor: '#2D2D2D',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    gap: 8,
  },
  typeText: {
    color: '#9CA3AF',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },

  // Inputs
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A1A1A',
    borderWidth: 1,
    borderColor: '#2D2D2D',
    borderRadius: 12,
    paddingHorizontal: 16,
  },
  inputIcon: {
    marginRight: 10,
  },
  input: {
    flex: 1,
    color: '#F9FAFB',
    fontSize: 15,
    paddingVertical: 16,
  },
  textArea: {
    height: 100,
    paddingTop: 16,
  },
  locateBtn: {
    padding: 8,
    marginRight: -8,
  },

  // Submit
  submitBtn: {
    backgroundColor: '#A855F7',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 18,
    borderRadius: 16,
    shadowColor: '#A855F7',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
    marginTop: 10,
  },
  submitBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },

  // Sheet (Success) View
  sheetContainer: {
    padding: 20,
  },
  sheetPaper: {
    backgroundColor: '#FFFFFF',
    borderRadius: 0,
    borderWidth: 1,
    borderColor: '#111',
    padding: 0,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.1,
    shadowRadius: 15,
    elevation: 8,
    marginBottom: 24,
    overflow: 'hidden',
  },
  sheetHeader: {
    borderBottomWidth: 1,
    borderBottomColor: '#111',
    padding: 16,
    alignItems: 'center',
  },
  sheetBrand: {
    fontSize: 12,
    fontWeight: '800',
    color: '#666',
    letterSpacing: 2,
    marginBottom: 4,
  },
  sheetTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: '#111',
    textAlign: 'center',
  },
  sheetId: {
    fontSize: 13,
    color: '#444',
    marginTop: 8,
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  sheetDetails: {
    borderBottomWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: '#111',
    marginBottom: 20,
  },
  sheetRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#111',
  },
  sheetLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#000',
    flex: 1,
    padding: 12,
    borderRightWidth: 1,
    borderRightColor: '#111',
  },
  sheetValue: {
    fontSize: 12,
    fontWeight: '600',
    color: '#111',
    flex: 2,
    padding: 12,
    textAlign: 'left',
  },
  sheetEvidence: {
    width: '100%',
    height: 160,
    borderRadius: 8,
    overflow: 'hidden',
    marginTop: 8,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: '#CCC',
  },
  sheetImage: {
    width: '100%',
    height: '100%',
  },
  signatureBox: {
    backgroundColor: '#fff',
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#111',
  },
  signatureHeader: {
    borderBottomWidth: 1,
    borderBottomColor: '#333',
    paddingBottom: 8,
    marginBottom: 16,
    width: '100%',
    alignItems: 'center',
  },
  signatureTitle: {
    color: '#111',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 1,
  },
  signatureContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 12,
  },
  unverifiedMark: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 3,
    borderColor: '#EF4444',
    alignItems: 'center',
    justifyContent: 'center',
  },
  signatureStatus: {
    color: '#EF4444', // Red for pending
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: 1,
  },
  signatureNote: {
    color: '#6B7280',
    fontSize: 11,
    textAlign: 'center',
    fontStyle: 'italic',
  },
  newReportBtn: {
    backgroundColor: '#A855F7',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  newReportBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },

  // History List
  historyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#2D2D2D',
  },
  backBtn: {
    marginRight: 16,
    padding: 4,
  },
  historyHeaderTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#F9FAFB',
  },
  historyScroll: {
    padding: 20,
  },
  noHistoryText: {
    color: '#9CA3AF',
    textAlign: 'center',
    marginTop: 40,
  },
  historyCard: {
    backgroundColor: '#1A1A1A',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#2D2D2D',
  },
  historyCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  historyCardId: {
    color: '#9CA3AF',
    fontSize: 12,
    fontWeight: '700',
  },
  historyCardDate: {
    color: '#6B7280',
    fontSize: 12,
  },
  historyCardType: {
    color: '#F9FAFB',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 4,
  },
  historyCardLocation: {
    color: '#6B7280',
    fontSize: 13,
    marginBottom: 12,
  },
  historyStatusBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  statusPending: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
  },
  statusVerified: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
  },
  historyStatusText: {
    fontSize: 11,
    fontWeight: '800',
  },
  statusPendingText: {
    color: '#EF4444',
  },
  statusVerifiedText: {
    color: '#10B981',
  }
});
