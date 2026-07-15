import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
  Modal,
  TextInput,
  Alert,
  Image,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSettings } from '../../../hooks/useSettings';
import { useSync } from '../../../hooks/useSync';
import { useAuth } from '../../../hooks/useAuth';
import { getApiBaseUrl } from '../../../lib/api';
import * as ImagePicker from 'expo-image-picker';

interface CountryStateData {
  country: string;
  states: string[];
}

const JURISDICTIONS: CountryStateData[] = [
  { country: 'India', states: ['Tamil Nadu', 'Karnataka', 'Delhi', 'Maharashtra'] },
  { country: 'United States', states: ['California', 'New York', 'Texas', 'Florida'] },
  { country: 'United Kingdom', states: ['England', 'Scotland', 'Wales'] },
  { country: 'UAE', states: ['Dubai', 'Abu Dhabi', 'Sharjah'] },
];

export default function ProfileScreen() {
  const router = useRouter();
  const { t, language, setLanguage, profile, updateProfile, notificationsEnabled, setNotificationsEnabled } = useSettings();
  const { syncStatus, triggerSync, isSyncing } = useSync();
  const { user, token, logout, updateUser } = useAuth();
  
  const [langModalVisible, setLangModalVisible] = useState(false);
  const [editProfileVisible, setEditProfileVisible] = useState(false);
  const [jurisdictionModalVisible, setJurisdictionModalVisible] = useState(false);
  const [vehiclesModalVisible, setVehiclesModalVisible] = useState(false);
  
  // Profile edit state
  const [tempName, setTempName] = useState(user?.name || profile.name);

  // Jurisdiction state
  const [selectedCountry, setSelectedCountry] = useState(profile.country || 'India');
  const [selectedState, setSelectedState] = useState(profile.state || 'Tamil Nadu');

  // Add vehicle form state
  const [showAddVehicleForm, setShowAddVehicleForm] = useState(false);
  const [vehicleName, setVehicleName] = useState('');
  const [vehicleNumber, setVehicleNumber] = useState('');
  const [vehicleModel, setVehicleModel] = useState('');
  const [vehicleType, setVehicleType] = useState('Car'); // Car or Two Wheeler
  const [rcPhoto, setRcPhoto] = useState<string | null>(null);
  const [savingVehicle, setSavingVehicle] = useState(false);

  const languages: { code: 'en' | 'ta' | 'hi' | 'te'; label: string }[] = [
    { code: 'en', label: 'English' },
    { code: 'ta', label: 'Tamil (தமிழ்)' },
    { code: 'hi', label: 'Hindi (हिन्दी)' },
    { code: 'te', label: 'Telugu (తెలుగు)' },
  ];

  // Emergency Contact State
  const [emergencyPopoverVisible, setEmergencyPopoverVisible] = useState(false);
  const [emergencyName, setEmergencyName] = useState(profile.emergencyContactName || '');
  const [emergencyPhone, setEmergencyPhone] = useState(profile.emergencyContact || '');
  const [isSavingContact, setIsSavingContact] = useState(false);

  useEffect(() => {
    setEmergencyName(profile.emergencyContactName || '');
    setEmergencyPhone(profile.emergencyContact || '');
  }, [profile.emergencyContactName, profile.emergencyContact]);

  const handleSaveEmergencyContact = async () => {
    if (!emergencyName.trim() || !emergencyPhone.trim()) {
      Alert.alert('Validation Error', 'Please enter both contact name and phone number.');
      return;
    }
    setIsSavingContact(true);
    try {
      await updateProfile({ 
        emergencyContact: emergencyPhone, 
        emergencyContactName: emergencyName 
      });
      if (user) {
        updateUser({
          ...user,
          emergencyContact: emergencyPhone,
          emergencyContactName: emergencyName,
        } as any);
      }
      if (token) {
        const baseUrl = getApiBaseUrl();
        const res = await fetch(`${baseUrl}/api/auth/update`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ 
            emergencyContact: emergencyPhone, 
            emergencyContactName: emergencyName 
          }),
        });
        if (!res.ok) {
          console.warn('Backend update failed, but updated locally');
        }
      }
      Alert.alert('Success', 'Emergency contact saved successfully!');
      setEmergencyPopoverVisible(false);
    } catch (e) {
      console.warn('Error saving emergency contact:', e);
      Alert.alert('Saved locally', 'Your contact was updated locally on your device.');
      setEmergencyPopoverVisible(false);
    } finally {
      setIsSavingContact(false);
    }
  };

  const handleSaveProfile = async () => {
    if (!tempName.trim()) {
      Alert.alert('Validation Error', 'Name cannot be empty.');
      return;
    }
    updateProfile({ name: tempName, avatar: tempName.charAt(0).toUpperCase() });
    
    // Save to backend if user exists
    if (user && token) {
      try {
        const baseUrl = getApiBaseUrl();
        await fetch(`${baseUrl}/api/auth/update`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ name: tempName }),
        });
        updateUser({ ...user, name: tempName });
      } catch (err) {
        console.warn('Backend update failed:', err);
      }
    }
    setEditProfileVisible(false);
  };

  const handleSaveJurisdiction = async () => {
    updateProfile({ country: selectedCountry, state: selectedState });
    Alert.alert('Jurisdiction Updated', `Successfully set driving rules for ${selectedCountry} · ${selectedState}.`);
    setJurisdictionModalVisible(false);
  };

  const handlePickRcPhoto = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Denied', 'DriveLegal needs photo library access to upload the RC photo.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      quality: 0.6,
    });
    if (!result.canceled && result.assets[0]?.uri) {
      setRcPhoto(result.assets[0].uri);
    }
  };

  const handleAddVehicle = async () => {
    if (!vehicleName.trim() || !vehicleNumber.trim() || !vehicleModel.trim()) {
      Alert.alert('Validation Error', 'Please fill in all vehicle details.');
      return;
    }

    setSavingVehicle(true);
    const newVehicle = {
      vehicleType,
      vehicleNumber: vehicleNumber.trim().toUpperCase(),
      vehicleName: vehicleName.trim(),
      vehicleModel: vehicleModel.trim(),
      rcBookUrl: rcPhoto || 'https://images.unsplash.com/photo-1549399542-7e3f8b79c341?q=80&w=200',
    };

    const currentVehicles = user?.vehicles || [];
    const updatedVehicles = [...currentVehicles, newVehicle];

    try {
      if (user) {
        updateUser({
          ...user,
          vehicles: updatedVehicles,
        } as any);
      }
      
      if (token) {
        const baseUrl = getApiBaseUrl();
        const res = await fetch(`${baseUrl}/api/auth/update`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ vehicles: updatedVehicles }),
        });
        if (!res.ok) {
          throw new Error('Server sync failed');
        }
      }
      Alert.alert('Success', 'Vehicle successfully registered.');
      
      // Clear form
      setVehicleName('');
      setVehicleNumber('');
      setVehicleModel('');
      setRcPhoto(null);
      setShowAddVehicleForm(false);
    } catch (err) {
      console.warn('Error adding vehicle:', err);
      Alert.alert('Saved locally', 'Could not sync with the database. Saved locally.');
      setShowAddVehicleForm(false);
    } finally {
      setSavingVehicle(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>

        {/* HEADER */}
        <View style={styles.header}>
          <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={24} color="#1f2937" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('you')}</Text>
          <View style={{ width: 32 }} />
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>

          {/* PROFILE CARD */}
          <TouchableOpacity style={styles.profileCard} onPress={() => {
            setTempName(user?.name || profile.name);
            setEditProfileVisible(true);
          }}>
            <View style={styles.avatarContainer}>
              <Text style={styles.avatarText}>{(user?.name || profile.name).charAt(0).toUpperCase()}</Text>
            </View>
            <View style={styles.profileInfo}>
              <Text style={styles.profileName}>{user?.name || profile.name}</Text>
            </View>
            <Ionicons name="pencil-outline" size={16} color="#9CA3AF" />
          </TouchableOpacity>

          {/* STATS ROW */}
          <View style={styles.statsRow}>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>0</Text>
              <Text style={styles.statLabel}>{t('open_violations')}</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statCard}>
              <Text style={styles.statValue}>₹0</Text>
              <Text style={styles.statLabel}>{t('outstanding_fines')}</Text>
            </View>
          </View>

          {/* SETTINGS LIST */}
          <View style={styles.settingsList}>

            <SettingsItem
              icon="globe-outline"
              iconBg="#E0F2FE"
              iconColor="#0369A1"
              label={t('country_state')}
              value={`${profile.country || 'India'} · ${profile.state || 'Tamil Nadu'}`}
              onPress={() => setJurisdictionModalVisible(true)}
            />
            <SettingsItem
              icon="language-outline"
              iconBg="#F3F4F6"
              iconColor="#4B5563"
              label={t('language')}
              value={languages.find(l => l.code === language)?.label}
              onPress={() => setLangModalVisible(true)}
            />
            <SettingsItem
              icon="document-text-outline"
              iconBg="#DCFCE7"
              iconColor="#15803D"
              label={t('vault_title')}
              onPress={() => router.push('/settings/documents')}
            />
            <SettingsItem
              icon="car-outline"
              iconBg="#FEF3C7"
              iconColor="#B45309"
              label={t('vehicles')}
              value={user?.vehicles?.length ? `${user.vehicles.length} saved` : 'No vehicle'}
              onPress={() => {
                setShowAddVehicleForm(false);
                setVehiclesModalVisible(true);
              }}
            />
            <SettingsItem
              icon="notifications-outline"
              iconBg="#F3F4F6"
              iconColor="#4B5563"
              label={t('notifications')}
              value={notificationsEnabled ? t('on') : t('off')}
              onPress={() => setNotificationsEnabled(!notificationsEnabled)}
            />
            <SettingsItem
              icon="shield-outline"
              iconBg="#FEE2E2"
              iconColor="#EF4444"
              label={t('emergency_alert')}
              value={profile.emergencyContactName ? `${profile.emergencyContactName} saved` : 'Not configured'}
              onPress={() => setEmergencyPopoverVisible(true)}
            />
            <SettingsItem
              icon="cloud-download-outline"
              iconBg="#DCFCE7"
              iconColor="#15803D"
              label={t('offline_pack')}
              value={
                isSyncing
                  ? 'Syncing...'
                  : syncStatus.lastSync.rules
                  ? `${syncStatus.lastSync.rules.split('T')[0]} refresh`
                  : 'Not synced yet'
              }
              valueColor="#D97706"
              onPress={() => triggerSync()}
            />
            <SettingsItem
              icon="lock-closed-outline"
              iconBg="#F3F4F6"
              iconColor="#4B5563"
              label={t('privacy_data')}
              onPress={() => {}}
            />
            <SettingsItem
              icon="log-out-outline"
              iconBg="#FEE2E2"
              iconColor="#EF4444"
              label="Log Out"
              onPress={async () => {
                await logout();
                router.replace('/login');
              }}
              isLast
            />
          </View>

        </ScrollView>
      </View>

      {/* Jurisdiction (Country/State) Modal */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={jurisdictionModalVisible}
        onRequestClose={() => setJurisdictionModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t('driving_jurisdiction')}</Text>
              <TouchableOpacity onPress={() => setJurisdictionModalVisible(false)}>
                <Ionicons name="close" size={24} color="#1f2937" />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ maxHeight: 400 }}>
              <Text style={styles.sectionLabel}>{t('select_country')}</Text>
              <View style={styles.selectionRow}>
                {JURISDICTIONS.map(item => (
                  <TouchableOpacity
                    key={item.country}
                    style={[styles.selectionPill, selectedCountry === item.country && styles.selectionPillSelected]}
                    onPress={() => {
                      setSelectedCountry(item.country);
                      setSelectedState(item.states[0]);
                    }}
                  >
                    <Text style={[styles.selectionPillText, selectedCountry === item.country && styles.selectionPillTextSelected]}>
                      {item.country}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={[styles.sectionLabel, { marginTop: 20 }]}>{t('select_state')}</Text>
              <View style={styles.selectionRow}>
                {JURISDICTIONS.find(j => j.country === selectedCountry)?.states.map(stateName => (
                  <TouchableOpacity
                    key={stateName}
                    style={[styles.selectionPill, selectedState === stateName && styles.selectionPillSelected]}
                    onPress={() => setSelectedState(stateName)}
                  >
                    <Text style={[styles.selectionPillText, selectedState === stateName && styles.selectionPillTextSelected]}>
                      {stateName}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>

            <TouchableOpacity style={styles.saveButton} onPress={handleSaveJurisdiction}>
              <Text style={styles.saveButtonText}>{t('apply_jurisdiction')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Language Modal */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={langModalVisible}
        onRequestClose={() => setLangModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t('language')}</Text>
              <TouchableOpacity onPress={() => setLangModalVisible(false)}>
                <Ionicons name="close" size={24} color="#1f2937" />
              </TouchableOpacity>
            </View>
            {languages.map((lang) => (
              <TouchableOpacity
                key={lang.code}
                style={[
                  styles.langOption,
                  language === lang.code && styles.langOptionSelected
                ]}
                onPress={() => {
                  setLanguage(lang.code);
                  setLangModalVisible(false);
                }}
              >
                <Text style={[
                  styles.langLabel,
                  language === lang.code && styles.langLabelSelected
                ]}>
                  {lang.label}
                </Text>
                {language === lang.code && (
                  <Ionicons name="checkmark" size={20} color="#D97706" />
                )}
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </Modal>

      {/* Emergency Contact Popover Modal */}
      <Modal
        visible={emergencyPopoverVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setEmergencyPopoverVisible(false)}
      >
        <TouchableOpacity 
          style={styles.popoverOverlay} 
          activeOpacity={1} 
          onPress={() => setEmergencyPopoverVisible(false)}
        >
          <View style={styles.popoverContainer}>
            <TouchableOpacity activeOpacity={1} style={styles.popoverContent}>
              <View style={styles.popoverHeader}>
                <Ionicons name="shield-outline" size={18} color="#EF4444" />
                <Text style={styles.popoverTitle}>{t('emergency_alert')}</Text>
              </View>
              <Text style={styles.popoverSub}>
                {t('emergency_desc')}
              </Text>
              
              <View style={[styles.popoverInputRow, { marginBottom: 10 }]}>
                <Ionicons name="person-outline" size={16} color="#9CA3AF" style={styles.popoverInputIcon} />
                <TextInput
                  style={styles.popoverInput}
                  value={emergencyName}
                  onChangeText={setEmergencyName}
                  placeholder={t('enter_contact_name')}
                  placeholderTextColor="#4B5563"
                />
              </View>

              <View style={styles.popoverInputRow}>
                <Ionicons name="phone-portrait-outline" size={16} color="#9CA3AF" style={styles.popoverInputIcon} />
                <TextInput
                  style={styles.popoverInput}
                  value={emergencyPhone}
                  onChangeText={setEmergencyPhone}
                  placeholder={t('enter_mobile_number')}
                  placeholderTextColor="#4B5563"
                  keyboardType="phone-pad"
                />
              </View>

              <TouchableOpacity 
                style={styles.popoverSaveBtn}
                onPress={handleSaveEmergencyContact}
                disabled={isSavingContact}
              >
                {isSavingContact ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.popoverSaveText}>{profile.emergencyContact ? 'Update Contact' : 'Add Contact'}</Text>
                )}
              </TouchableOpacity>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Edit Profile Modal */}
      <Modal
        animationType="fade"
        transparent={true}
        visible={editProfileVisible}
        onRequestClose={() => setEditProfileVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t('edit_profile')}</Text>
              <TouchableOpacity onPress={() => setEditProfileVisible(false)}>
                <Ionicons name="close" size={24} color="#1f2937" />
              </TouchableOpacity>
            </View>
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>{t('full_name')}</Text>
              <TextInput
                style={styles.textInput}
                value={tempName}
                onChangeText={setTempName}
                placeholder={t('enter_your_name')}
              />
            </View>
            <TouchableOpacity style={styles.saveButton} onPress={handleSaveProfile}>
              <Text style={styles.saveButtonText}>{t('save')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Vehicles Modal with Manager Form */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={vehiclesModalVisible}
        onRequestClose={() => setVehiclesModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t('vehicles')}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <TouchableOpacity 
                  style={styles.vehicleAddHeaderBtn}
                  onPress={() => setShowAddVehicleForm(!showAddVehicleForm)}
                >
                  <Text style={styles.vehicleAddHeaderBtnText}>{showAddVehicleForm ? t('view_list') : `+ ${t('add')}`}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setVehiclesModalVisible(false)}>
                  <Ionicons name="close" size={24} color="#1f2937" />
                </TouchableOpacity>
              </View>
            </View>
            
            {showAddVehicleForm ? (
              // Add Vehicle Form View
              <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={false}>
                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>{t('vehicle_name')}</Text>
                  <TextInput
                    style={styles.textInput}
                    value={vehicleName}
                    onChangeText={setVehicleName}
                    placeholder={t('eg_swift')}
                  />
                </View>

                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>{t('registration_number')}</Text>
                  <TextInput
                    style={styles.textInput}
                    value={vehicleNumber}
                    onChangeText={setVehicleNumber}
                    placeholder={t('eg_tn')}
                    autoCapitalize="characters"
                  />
                </View>

                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>{t('make_model')}</Text>
                  <TextInput
                    style={styles.textInput}
                    value={vehicleModel}
                    onChangeText={setVehicleModel}
                    placeholder={t('eg_swift_vxi')}
                  />
                </View>

                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>{t('vehicle_type')}</Text>
                  <View style={styles.selectionRow}>
                    {[
                      { id: 'Car', label: t('car') },
                      { id: 'Two Wheeler', label: t('two_wheeler') },
                      { id: 'Commercial', label: t('commercial') }
                    ].map(type => (
                      <TouchableOpacity
                        key={type.id}
                        style={[styles.selectionPill, vehicleType === type.id && styles.selectionPillSelected]}
                        onPress={() => setVehicleType(type.id)}
                      >
                        <Text style={[styles.selectionPillText, vehicleType === type.id && styles.selectionPillTextSelected]}>
                          {type.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>

                {/* Photo Upload Row */}
                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>{t('rc_book_photo')}</Text>
                  <TouchableOpacity style={styles.photoPickerBox} onPress={handlePickRcPhoto}>
                    {rcPhoto ? (
                      <Image source={{ uri: rcPhoto }} style={styles.photoPreview} />
                    ) : (
                      <>
                        <Ionicons name="camera-outline" size={24} color="#D97706" />
                        <Text style={styles.photoPickerText}>{t('select_rc_photo')}</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>

                <TouchableOpacity 
                  style={[styles.saveButton, savingVehicle && { backgroundColor: '#fcd34d' }]} 
                  onPress={handleAddVehicle}
                  disabled={savingVehicle}
                >
                  {savingVehicle ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.saveButtonText}>{t('add_vehicle')}</Text>
                  )}
                </TouchableOpacity>
              </ScrollView>
            ) : (
              // Vehicles List View
              <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={false}>
                {(!user?.vehicles || user.vehicles.length === 0) ? (
                  <View style={styles.emptyVehicles}>
                    <Ionicons name="car-outline" size={48} color="#9ca3af" />
                    <Text style={styles.emptyVehiclesText}>{t('no_vehicles')}</Text>
                    <TouchableOpacity style={styles.addButtonSolid} onPress={() => setShowAddVehicleForm(true)}>
                      <Text style={styles.addButtonSolidText}>{t('add_vehicle')}</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  user.vehicles.map((v, idx) => (
                    <View key={idx} style={styles.vehicleItemCard}>
                      <View style={styles.vehicleItemHeader}>
                        <View>
                          <Text style={styles.vehicleItemName}>{v.vehicleName || 'Unnamed Vehicle'}</Text>
                          <Text style={styles.vehicleItemModel}>{v.vehicleModel || 'Unknown Model'} · {v.vehicleType}</Text>
                        </View>
                        <View style={styles.plateBadge}>
                          <Text style={styles.plateText}>{v.vehicleNumber}</Text>
                        </View>
                      </View>
                      {v.rcBookUrl && (
                        <View style={styles.rcAttachedRow}>
                          <Ionicons name="document-attach-outline" size={14} color="#16A34A" />
                          <Text style={styles.rcAttachedText}>RC Book Photo attached</Text>
                        </View>
                      )}
                    </View>
                  ))
                )}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

    </SafeAreaView>
  );
}

interface SettingsItemProps {
  icon: string;
  iconBg: string;
  iconColor: string;
  label: string;
  value?: string;
  valueColor?: string;
  onPress: () => void;
  isLast?: boolean;
}

function SettingsItem({
  icon, iconBg, iconColor, label, value, valueColor, onPress, isLast,
}: SettingsItemProps) {
  return (
    <>
      <TouchableOpacity style={styles.settingsItem} onPress={onPress}>
        <View style={[styles.settingsIconWrapper, { backgroundColor: iconBg }]}>
          <Ionicons name={icon as any} size={18} color={iconColor} />
        </View>
        <Text style={styles.settingsLabel}>{label}</Text>
        <View style={styles.settingsRight}>
          {value ? (
            <Text style={[styles.settingsValue, valueColor ? { color: valueColor } : {}]}>
              {value}
            </Text>
          ) : null}
          <Ionicons name="chevron-forward" size={18} color="#D1D5DB" />
        </View>
      </TouchableOpacity>
      {!isLast && <View style={styles.settingsDivider} />}
    </>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#fff' },
  container: { flex: 1, backgroundColor: '#FAF8F5' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 16,
    backgroundColor: '#fff',
  },
  backButton: { padding: 4 },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#1f2937' },
  scrollContent: { paddingBottom: 40, paddingHorizontal: 20 },

  // Profile Card
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 20,
    marginTop: 20,
    borderWidth: 1,
    borderColor: '#F3F4F6',
    gap: 16,
  },
  avatarContainer: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#FEF3C7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 24, fontWeight: '700', color: '#B45309' },
  profileInfo: { flex: 1, gap: 4 },
  profileName: { fontSize: 18, fontWeight: '700', color: '#1F2937' },
  profileMeta: { fontSize: 13, color: '#6B7280' },
  safeDriverBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  safeDriverText: { fontSize: 13, fontWeight: '600', color: '#16A34A' },

  // Stats
  statsRow: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderRadius: 16,
    marginTop: 16,
    borderWidth: 1,
    borderColor: '#F3F4F6',
    overflow: 'hidden',
  },
  statCard: {
    flex: 1,
    paddingVertical: 16,
    alignItems: 'center',
    gap: 4,
  },
  statDivider: { width: 1, backgroundColor: '#F3F4F6', marginVertical: 12 },
  statValue: { fontSize: 22, fontWeight: '800', color: '#1F2937' },
  statLabel: { fontSize: 11, color: '#9CA3AF', textAlign: 'center' },

  // Settings List
  settingsList: {
    backgroundColor: '#fff',
    borderRadius: 16,
    marginTop: 24,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: '#F3F4F6',
  },
  settingsItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    gap: 12,
  },
  settingsIconWrapper: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingsLabel: { flex: 1, fontSize: 15, fontWeight: '500', color: '#1F2937' },
  settingsRight: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  settingsValue: { fontSize: 13, color: '#9CA3AF', flexShrink: 1 },
  settingsDivider: { height: 1, backgroundColor: '#F9FAFB', marginLeft: 48 },

  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    minHeight: 320,
    maxHeight: '90%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1f2937',
  },
  langOption: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  langOptionSelected: {
    backgroundColor: '#FEF3C7',
    marginHorizontal: -24,
    paddingHorizontal: 24,
  },
  langLabel: {
    fontSize: 16,
    color: '#4b5563',
  },
  langLabelSelected: {
    color: '#D97706',
    fontWeight: '700',
  },

  // Jurisdiction & Add forms UI
  sectionLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#6b7280',
    marginBottom: 10,
    letterSpacing: 0.5,
  },
  selectionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  selectionPill: {
    backgroundColor: '#f3f4f6',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  selectionPillSelected: {
    backgroundColor: '#FFF7ED',
    borderColor: '#D97706',
  },
  selectionPillText: {
    fontSize: 13,
    color: '#4b5563',
    fontWeight: '500',
  },
  selectionPillTextSelected: {
    color: '#D97706',
    fontWeight: '700',
  },

  // Edit Profile / Form Inputs
  inputGroup: {
    marginBottom: 18,
  },
  inputLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6b7280',
    marginBottom: 6,
  },
  textInput: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    padding: 12,
    fontSize: 15,
    color: '#1f2937',
    ...Platform.select({
      web: { outlineStyle: 'none' } as any,
    }),
  },
  saveButton: {
    backgroundColor: '#D97706',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    marginTop: 10,
  },
  saveButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },

  // Vehicles modal add
  vehicleAddHeaderBtn: {
    backgroundColor: '#FFF7ED',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  vehicleAddHeaderBtnText: {
    fontSize: 13,
    color: '#D97706',
    fontWeight: '700',
  },
  emptyVehicles: {
    alignItems: 'center',
    paddingVertical: 40,
    gap: 12,
  },
  emptyVehiclesText: {
    fontSize: 14,
    color: '#6b7280',
  },
  addButtonSolid: {
    backgroundColor: '#D97706',
    borderRadius: 16,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  addButtonSolidText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  vehicleItemCard: {
    backgroundColor: '#FAF8F5',
    padding: 16,
    borderRadius: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#F3F4F6',
  },
  vehicleItemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  vehicleItemName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1F2937',
  },
  vehicleItemModel: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 2,
  },
  plateBadge: {
    backgroundColor: '#F3F4F6',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  plateText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#374151',
  },
  rcAttachedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 10,
  },
  rcAttachedText: {
    fontSize: 11,
    color: '#16A34A',
    fontWeight: '600',
  },

  // Photo Picker
  photoPickerBox: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderStyle: 'dashed',
    borderRadius: 12,
    height: 100,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FAF8F5',
    overflow: 'hidden',
  },
  photoPreview: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  photoPickerText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#D97706',
    marginTop: 6,
  },

  // Popover Styles
  popoverOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  popoverContainer: {
    width: '85%',
    maxWidth: 340,
  },
  popoverContent: {
    backgroundColor: '#1c1c1c',
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 10,
    borderWidth: 1,
    borderColor: '#333',
  },
  popoverHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  popoverTitle: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '700',
    marginLeft: 8,
  },
  popoverSub: {
    color: '#9CA3AF',
    fontSize: 12,
    marginBottom: 20,
    lineHeight: 18,
  },
  popoverInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#2D2D2D',
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 44,
  },
  popoverInputIcon: {
    marginRight: 10,
  },
  popoverInput: {
    flex: 1,
    color: '#F3F4F6',
    fontSize: 14,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as any,
  },
  popoverSaveBtn: {
    backgroundColor: '#B91C1C',
    borderRadius: 10,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 20,
  },
  popoverSaveText: {
    color: '#FFF',
    fontWeight: '700',
    fontSize: 14,
  },
});
