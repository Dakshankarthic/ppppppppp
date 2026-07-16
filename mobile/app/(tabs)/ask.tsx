import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Platform,
  Animated,
  KeyboardAvoidingView,
  Alert,
  useWindowDimensions,
  Image
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons, Feather } from '@expo/vector-icons';
import { ChatHistoryTurn } from '../../hooks/useQuery';
import { useSmartChat } from '../../hooks/useSmartChat';
import { TierIndicator } from '../../components/TierIndicator';
import { OfflineBanner } from '../../components/OfflineBanner';
import { buildCitationLabel } from '../../lib/citations';
import { buildWelcomeText, WELCOME_SUGGESTIONS } from '../../lib/welcome';
import { StatusBar } from 'expo-status-bar';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useHistory } from '../../hooks/useHistory';
import { useSettings } from '../../hooks/useSettings';
import { useAuth } from '../../hooks/useAuth';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { requestRecordingPermissionsAsync, setAudioModeAsync, RecordingPresets, AudioModule } from 'expo-audio';
import { readAsStringAsync } from 'expo-file-system/legacy';
import { getApiBaseUrl } from '../../lib/api';
import { MarkdownRenderer } from '../../components/MarkdownRenderer';
export default function DriveLegalAssistant() {
  const { q, sid, new: isNew } = useLocalSearchParams<{ q: string, sid: string, new: string }>();
  const { updateSession, sessions } = useHistory();
  const { t, profile, initialized } = useSettings();
  const { user } = useAuth();
  const router = useRouter();

  const makeWelcomeMessage = (): ChatMessage => ({
    id: '1',
    sender: 'ai',
    text: `${t('ask_intro')}\n\n${t('ask_tip')}`,
    suggestions: [t('ask_suggest_1'), t('ask_suggest_2'), t('ask_suggest_3')],
  });

  const [queryText, setQueryText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isAttachMenuOpen, setIsAttachMenuOpen] = useState(false);
  const [currentLocation, setCurrentLocation] = useState<string>('');
  const [pendingImage, setPendingImage] = useState<{ base64: string; mimeType: string } | null>(null);
  const attachMenuAnim = useRef(new Animated.Value(0)).current;
  const recordingRef = useRef<any>(null);
  const recognitionRef = useRef<any>(null);
  
  const scrollRef = useRef<ScrollView>(null);
  const lastQueryRef = useRef<string>('');

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const { width } = useWindowDimensions();
  // Persistent desktop sidebar is a web-only pattern — a native phone in landscape
  // can easily exceed 768dp width, which would otherwise wrongly reserve sidebar
  // space in the chat layout and squeeze message text into a sliver.
  const isDesktop = Platform.OS === 'web' && width >= 768;
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const sidebarWidth = 280;
  const sidebarAnim = useRef(new Animated.Value(0)).current;

  const toggleSidebar = () => {
    const toValue = isSidebarOpen ? 0 : 1;
    setIsSidebarOpen(!isSidebarOpen);
    Animated.timing(sidebarAnim, {
      toValue,
      duration: 250,
      useNativeDriver: false,
    }).start();
  };

  const closeSidebarMobile = () => {
    if (!isDesktop && isSidebarOpen) {
      toggleSidebar();
    }
  };

  const handleNewChat = () => {
    const welcome = makeWelcomeMessage();
    setChatHistory([welcome]);
    chatHistoryRef.current = [welcome];
    setActiveSessionId(null);
    router.setParams({ sid: '', q: '', new: '' });
    closeSidebarMobile();
  };

  const handleLoadSession = (session: any) => {
    const welcome = makeWelcomeMessage();
    const fullHistory = [welcome, ...session.messages];
    setChatHistory(fullHistory);
    chatHistoryRef.current = fullHistory;
    setActiveSessionId(session.id);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    closeSidebarMobile();
  };

  interface ChatMessage {
    id: string;
    sender: 'user' | 'ai';
    text: string;
    suggestions?: string[];
    source?: string;
    imageBase64?: string;
    mimeType?: string;
  }

  const [chatHistory, setChatHistory] = useState<ChatMessage[]>(() => [
    {
      id: '1',
      sender: 'ai',
      text: `${t('ask_intro')}\n\n${t('ask_tip')}`,
      suggestions: [t('ask_suggest_1'), t('ask_suggest_2'), t('ask_suggest_3')],
    },
  ]);
  const chatHistoryRef = useRef<ChatMessage[]>(chatHistory);
  const {
    data,
    streamingText,
    isLoading,
    error,
    tier,
    tinyModelStatus,
    tinyDownloadProgress,
    submitQuery,
  } = useSmartChat();

  useEffect(() => {
    chatHistoryRef.current = chatHistory;
  }, [chatHistory]);

  // Stop any in-progress recording/speech-recognition if the user navigates away mid-recording.
  useEffect(() => {
    return () => {
      try { recordingRef.current?.stop(); } catch {}
      try { recognitionRef.current?.stop(); } catch {}
    };
  }, []);

  useEffect(() => {
    if (!initialized) return;
    setChatHistory((prev) => {
      if (prev.length === 1 && prev[0].id === '1') {
        const welcome = makeWelcomeMessage();
        chatHistoryRef.current = [welcome];
        return [welcome];
      }
      return prev;
    });
  }, [initialized, profile.name]);

  useEffect(() => {
    (async () => {
      try {
        let { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          let loc;
          if (Platform.OS === 'web') {
            try {
              loc = await Promise.race([
                Location.getCurrentPositionAsync({}),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
              ]) as any;
            } catch (e) {
              loc = {
                coords: {
                  latitude: 13.0827,
                  longitude: 80.2707,
                }
              };
            }
          } else {
            loc = await Location.getCurrentPositionAsync({});
          }
          let geocode = await Location.reverseGeocodeAsync(loc.coords);
          if (geocode.length > 0) {
            const place = geocode[0];
            const locationName = [place.street, place.city].filter(Boolean).join(' · ');
            setCurrentLocation(locationName);
          } else {
            setCurrentLocation('Chennai, Tamil Nadu');
          }
        } else {
          setCurrentLocation('Chennai, Tamil Nadu');
        }
      } catch (e) {
        console.log('Location error on mount in ask:', e);
        setCurrentLocation('Chennai, Tamil Nadu');
      }
    })();
  }, []);

  useEffect(() => {
    if (isNew === 'true') {
      const welcome = makeWelcomeMessage();
      setChatHistory([welcome]);
      chatHistoryRef.current = [welcome];
      router.setParams({ new: '' });
      return;
    }

    if (sid) {
      const session = sessions.find(s => s.id === sid);
      if (session) {
        const welcome = makeWelcomeMessage();
        const fullHistory = [welcome, ...session.messages];
        setChatHistory(fullHistory);
        chatHistoryRef.current = fullHistory;
        setActiveSessionId(session.id);
        setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
      }
    } else if (q) {
      handleSend(q);
    }
  }, [q, sid, isNew]); 

  const handleSend = async (textOverride?: string) => {
    const text = textOverride || queryText || (pendingImage ? 'Analyze this traffic/legal image and verify any fine or rule details.' : '');
    if (!text.trim()) return;
    
    lastQueryRef.current = text;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      sender: 'user',
      text: text,
      imageBase64: pendingImage?.base64,
      mimeType: pendingImage?.mimeType,
    };
    
    // Use ref so we always send the latest turns (avoids stale React state)
    const historyForApi: ChatHistoryTurn[] = chatHistoryRef.current
      .filter((m) => m.id !== '1')
      .slice(-20)
      .map((m) => ({
        role: m.sender === 'user' ? ('user' as const) : ('model' as const),
        parts: [m.text],
      }));

    setChatHistory((prev) => [...prev, userMessage]);
    setQueryText('');

    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    const imageForApi = pendingImage;
    setPendingImage(null);
    
    // Extract primary vehicle type if available
    let primaryVehicleType = 'ALL';
    if (user && user.vehicles && user.vehicles.length > 0) {
      primaryVehicleType = user.vehicles[0].vehicleType;
    }

    await submitQuery(
      text,
      historyForApi,
      imageForApi
        ? { imageBase64: imageForApi.base64, imageMime: imageForApi.mimeType }
        : undefined,
      primaryVehicleType,
      currentLocation,
      profile.country,
      profile.state
    );
  };

  useEffect(() => {
    if (data) {
      const respText = data.response || data.text || "I found some information regarding your query.";
      const citation =
        (data.citations && data.citations.length > 0
          ? data.citations.join(' · ')
          : buildCitationLabel(data, currentLocation)) || undefined;

      const aiResponse: ChatMessage = {
        id: (Date.now() + 1).toString(),
        sender: 'ai',
        text: respText,
        source: citation,
      };

      if (lastQueryRef.current) {
        // Save the full session minus welcome message
        const fullHistory = [...chatHistoryRef.current, aiResponse].filter(m => m.id !== '1');
        let title = fullHistory[0]?.text || lastQueryRef.current;
        
        // Auto naming: keep it relevant and short (max 5 words)
        if (title.startsWith('I am at ')) {
          title = 'Local traffic rules';
        } else {
          const words = title.trim().split(/\s+/);
          if (words.length > 5) {
            title = words.slice(0, 5).join(' ') + '...';
          }
        }

        const newId = updateSession(activeSessionId, title, fullHistory);
        if (newId && newId !== activeSessionId) {
          setActiveSessionId(newId);
        }
        lastQueryRef.current = '';
      }

      setChatHistory(prev => [...prev, aiResponse]);
      chatHistoryRef.current = [...chatHistoryRef.current, aiResponse];
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    } else if (error) {
      const errorResponse: ChatMessage = {
        id: (Date.now() + 1).toString(),
        sender: 'ai',
        text: `Sorry, I couldn't find information for that. ${error}`,
      };
      setChatHistory(prev => [...prev, errorResponse]);
      chatHistoryRef.current = [...chatHistoryRef.current, errorResponse];
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [data, error]);

  const toggleAttachMenu = () => {
    const toValue = isAttachMenuOpen ? 0 : 1;
    setIsAttachMenuOpen(!isAttachMenuOpen);
    Animated.spring(attachMenuAnim, {
      toValue,
      useNativeDriver: true,
      tension: 50,
      friction: 7
    }).start();
  };

  const handlePickImage = async () => {
    toggleAttachMenu();
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      quality: 0.7,
      base64: true,
    });
    if (!result.canceled && result.assets[0]?.base64) {
      const asset = result.assets[0];
      setPendingImage({
        base64: asset.base64 || '',
        mimeType: asset.mimeType || 'image/jpeg',
      });
      setQueryText('Analyze this traffic/legal image and verify any fine or rule details.');
      Alert.alert("Image ready", "Tap send to analyze it with the local vision model.");
    }
  };

  const handleTakeCamera = async () => {
    toggleAttachMenu();
    const permissionResult = await ImagePicker.requestCameraPermissionsAsync();
    if (!permissionResult.granted) {
      Alert.alert("Permission Required", "Camera permission is required to take photos.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      quality: 0.7,
      base64: true,
    });
    if (!result.canceled && result.assets[0]?.base64) {
      const asset = result.assets[0];
      setPendingImage({
        base64: asset.base64 || '',
        mimeType: asset.mimeType || 'image/jpeg',
      });
      setQueryText('Analyze this traffic/legal image and verify any fine or rule details.');
      Alert.alert("Image ready", "Tap send to analyze it with the local vision model.");
    }
  };

  const handlePaste = (e: any) => {
    if (Platform.OS === 'web' && e.clipboardData && e.clipboardData.items) {
      const items = e.clipboardData.items;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const blob = items[i].getAsFile();
          if (blob) {
            const reader = new FileReader();
            reader.onload = (event) => {
              const base64DataUrl = event.target?.result as string;
              if (base64DataUrl) {
                const parts = base64DataUrl.split(',');
                const mime = parts[0].split(':')[1].split(';')[0];
                const base64Str = parts[1];
                setPendingImage({
                  base64: base64Str,
                  mimeType: mime,
                });
                if (!queryText.trim()) {
                  setQueryText('Analyze this pasted image and verify any details.');
                }
              }
            };
            reader.readAsDataURL(blob);
          }
        }
      }
    }
  };


  const handlePickDocument = async () => {
    toggleAttachMenu();
    // Document analysis isn't wired to the backend yet (only photo evidence is) —
    // avoid telling the user it was "uploaded for analysis" when nothing happens with it.
    Alert.alert("Coming soon", "Document analysis isn't available yet. Try attaching a photo or typing your question instead.");
  };

  const handleVoiceInput = async () => {
    if (isAttachMenuOpen) toggleAttachMenu();

    // ── WEB: use browser SpeechRecognition API ──────────────────────────────
    if (Platform.OS === 'web') {
      const SpeechRecognition =
        (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

      if (!SpeechRecognition) {
        Alert.alert('Not supported', 'Voice search is not supported in this browser. Try Chrome.');
        return;
      }

      // Second tap → stop listening
      if (isListening && recognitionRef.current) {
        recognitionRef.current.stop();
        return;
      }

      const recognition = new SpeechRecognition();
      recognitionRef.current = recognition;
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = 'en-IN';

      recognition.onstart = () => setIsListening(true);
      recognition.onresult = (event: any) => {
        setIsListening(false);
        recognitionRef.current = null;
        const transcript = event.results[0][0].transcript;
        setQueryText(transcript);
      };
      recognition.onerror = (event: any) => {
        setIsListening(false);
        recognitionRef.current = null;
        if (event.error !== 'aborted') {
          console.warn('Speech recognition error:', event.error);
          Alert.alert('Voice error', `Speech recognition error: ${event.error}`);
        }
      };
      recognition.onend = () => {
        setIsListening(false);
        recognitionRef.current = null;
      };

      recognition.start();
      return;
    }

    // ── NATIVE: record with expo-audio → transcribe via backend ────────────────
    // Second tap → stop recording and transcribe
    if (isListening && recordingRef.current) {
      try {
        const recording = recordingRef.current;
        recordingRef.current = null;
        setIsListening(false);
        await recording.stop();
        const uri = recording.uri;
        if (!uri) throw new Error('No audio file recorded');

        // Read file as base64
        const base64Audio = await readAsStringAsync(uri, {
          encoding: 'base64',
        });

        // Send to backend /transcribe
        const BASE_URL = getApiBaseUrl();
        setIsListening(false);
        const res = await fetch(`${BASE_URL}/transcribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Bypass-Tunnel-Reminder': 'true' },
          body: JSON.stringify({ audio_base64: base64Audio, mime_type: 'audio/m4a' }),
        });
        const json = await res.json();
        if (json.text && json.text.trim()) {
          setQueryText(json.text.trim());
        } else {
          Alert.alert('No speech detected', json.message || 'Could not understand audio. Try again.');
        }
      } catch (err: any) {
        setIsListening(false);
        recordingRef.current = null;
        Alert.alert('Voice error', err.message || 'Failed to transcribe audio.');
      }
      return;
    }

    // First tap → request permission and start recording
    try {
      const { status } = await requestRecordingPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission required', 'Microphone access is needed for voice search.');
        return;
      }

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      const recording = new (AudioModule as any).AudioRecorder(RecordingPresets.HIGH_QUALITY);
      await recording.prepareToRecordAsync();
      recording.record();
      recordingRef.current = recording;
      setIsListening(true);
    } catch (err: any) {
      setIsListening(false);
      recordingRef.current = null;
      Alert.alert('Voice error', err.message || 'Could not start recording.');
    }
  };

  const handleShareLocation = async () => {
    toggleAttachMenu();
    try {
      let { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        if (Platform.OS === 'web') {
          console.warn("Permission Denied: Location access is required.");
        } else {
          Alert.alert("Permission Denied", "Location access is required.");
        }
        return;
      }
      
      let location;
      if (Platform.OS === 'web') {
        try {
          location = await Promise.race([
            Location.getCurrentPositionAsync({}),
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
        location = await Location.getCurrentPositionAsync({});
      }
      handleSend(`I am at ${location.coords.latitude}, ${location.coords.longitude}. What rules apply here?`);
    } catch (e) {
      console.warn("Error sharing location:", e);
      handleSend(`I am at 13.0827, 80.2707. What rules apply here?`);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      
      <View style={styles.mainLayout}>
        {/* Main Chat Area */}
        <KeyboardAvoidingView 
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.container}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
        >
          <View style={styles.trustBanner}>
            <Ionicons name="shield-checkmark-outline" size={16} color="#92400e" />
            <Text style={styles.trustBannerText}>
              Local AI + verified fine DB · Not government · Not legal advice
            </Text>
          </View>

          <OfflineBanner
            tier={tier}
            tinyModelStatus={tinyModelStatus}
            tinyDownloadProgress={tinyDownloadProgress}
          />

          {/* Header */}
          <View style={styles.header}>
            <TouchableOpacity onPress={toggleSidebar} style={styles.backButton}>
              <Feather name="sidebar" size={24} color="#1c1c1c" />
            </TouchableOpacity>
          
          <View style={styles.headerTitleContainer}>
            <View style={styles.assistantIcon}>
              <MaterialCommunityIcons name="auto-fix" size={18} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.headerTitle} numberOfLines={1} ellipsizeMode="tail">{t('assistant_name')}</Text>
              <TierIndicator tier={tier} />
            </View>
          </View>
        </View>

        {/* Chat Area */}
        <ScrollView 
          ref={scrollRef}
          style={styles.chatArea}
          contentContainerStyle={styles.chatContent}
        >
          <Text style={styles.dateDivider}>
            Today, {new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
          </Text>
          
          {chatHistory.map((msg, index) => (
            <View key={msg.id} style={[
              styles.messageWrapper,
              msg.sender === 'user' ? styles.userWrapper : styles.aiWrapper
            ]}>
              {msg.sender === 'ai' && (
                <View style={styles.aiAvatar}>
                  <MaterialCommunityIcons name="auto-fix" size={14} color="#d97706" />
                </View>
              )}
              
              <View style={styles.bubbleContainer}>
                {msg.sender === 'ai' && msg.source && (
                  <View style={styles.sourceTag}>
                    <Ionicons name="book" size={12} color="#d97706" />
                    <Text style={styles.sourceTagText}>{msg.source}</Text>
                  </View>
                )}
                
                <View style={[
                  styles.messageBubble,
                  msg.sender === 'user' ? styles.userBubble : styles.aiBubble
                ]}>
                  {msg.imageBase64 && (
                    <Image
                      source={{ uri: `data:${msg.mimeType || 'image/jpeg'};base64,${msg.imageBase64}` }}
                      style={{ width: '100%', aspectRatio: 1, borderRadius: 8, marginBottom: 8 }}
                      resizeMode="cover"
                    />
                  )}
                  <MarkdownRenderer content={msg.text} isAI={msg.sender === 'ai'} />
                </View>
                
                {msg.sender === 'ai' && msg.source && msg.id !== '1' && (
                  <Text style={styles.sourceFooter}>{msg.source}</Text>
                )}
                
                {msg.sender === 'ai' && index === chatHistory.length - 1 && msg.suggestions && (
                  <View style={styles.suggestionsRow}>
                    {msg.suggestions.map((s, i) => (
                      <TouchableOpacity key={i} style={styles.suggestionChip} onPress={() => handleSend(s)}>
                        <Text style={styles.suggestionText}>{s}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>
            </View>
          ))}
          
          {isLoading && streamingText ? (
            <View style={[styles.messageWrapper, styles.aiWrapper]}>
              <View style={styles.aiAvatar}>
                <MaterialCommunityIcons name="auto-fix" size={14} color="#d97706" />
              </View>
              <View style={styles.bubbleContainer}>
                <View style={[styles.messageBubble, styles.aiBubble]}>
                  <MarkdownRenderer content={streamingText} isAI />
                </View>
              </View>
            </View>
          ) : isLoading ? (
            <View style={styles.loadingWrapper}>
              <ActivityIndicator size="small" color="#d97706" />
            </View>
          ) : null}
        </ScrollView>

        {/* Attachment Menu */}
        <Animated.View style={[
          styles.attachMenu,
          {
            transform: [{
              translateY: attachMenuAnim.interpolate({
                inputRange: [0, 1],
                outputRange: [200, 0]
              })
            }],
            opacity: attachMenuAnim
          }
        ]}>
          <View style={styles.attachRow}>
            <TouchableOpacity style={styles.attachItem} onPress={handleTakeCamera}>
              <View style={[styles.attachIcon, { backgroundColor: '#FCE7F3' }]}>
                <Ionicons name="camera" size={24} color="#BE185D" />
              </View>
              <Text style={styles.attachLabel}>Camera</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.attachItem} onPress={handlePickImage}>
              <View style={[styles.attachIcon, { backgroundColor: '#E0F2FE' }]}>
                <Ionicons name="image" size={24} color="#0369A1" />
              </View>
              <Text style={styles.attachLabel}>Gallery</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.attachItem} onPress={handlePickDocument}>
              <View style={[styles.attachIcon, { backgroundColor: '#DCFCE7' }]}>
                <Ionicons name="document-text" size={24} color="#15803D" />
              </View>
              <Text style={styles.attachLabel}>Doc</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.attachItem} onPress={handleVoiceInput}>
              <View style={[styles.attachIcon, { backgroundColor: isListening ? '#FEE2E2' : '#FEF3C7' }]}>
                <Ionicons name={isListening ? 'stop-circle' : 'mic'} size={24} color={isListening ? '#DC2626' : '#B45309'} />
              </View>
              <Text style={[styles.attachLabel, isListening && { color: '#DC2626' }]}>{isListening ? 'Stop' : 'Voice'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.attachItem} onPress={handleShareLocation}>
              <View style={[styles.attachIcon, { backgroundColor: '#F3F4F6' }]}>
                <Ionicons name="location" size={24} color="#4B5563" />
              </View>
              <Text style={styles.attachLabel}>Location</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>

        {/* Input Area */}
        <View style={styles.inputContainer}>
          <View style={styles.inputWrapper}>
            <TouchableOpacity style={styles.attachButton} onPress={toggleAttachMenu}>
              <Animated.View style={{ transform: [{ rotate: attachMenuAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '45deg'] }) }] }}>
                <Ionicons name="add" size={24} color={isAttachMenuOpen ? "#d97706" : "#6b7280"} />
              </Animated.View>
            </TouchableOpacity>
            
            <TextInput
              style={[
                styles.input,
                Platform.OS === 'web' && { outlineStyle: 'none' } as any
              ]}
              placeholder={pendingImage ? 'Image attached. Add a question...' : t('ask_placeholder')}
              placeholderTextColor="#9ca3af"
              value={queryText}
              onChangeText={setQueryText}
              onSubmitEditing={() => handleSend()}
              selectionColor="#d97706"
              onFocus={() => isAttachMenuOpen && toggleAttachMenu()}
            />
            
            <TouchableOpacity style={styles.micButton} onPress={handleVoiceInput}>
              <Ionicons name="mic-outline" size={24} color={isListening ? "#d97706" : "#6b7280"} />
            </TouchableOpacity>
            
            <TouchableOpacity
              style={[styles.sendButton, ((!queryText.trim() && !pendingImage) || isLoading) && styles.sendButtonDisabled]}
              onPress={() => handleSend()}
              disabled={(!queryText.trim() && !pendingImage) || isLoading}
            >
              <Ionicons name="send" size={18} color="#fff" />
            </TouchableOpacity>
          </View>
          </View>
        </KeyboardAvoidingView>

        {/* Backdrop for Mobile */}
        {!isDesktop && isSidebarOpen && (
          <TouchableOpacity 
            style={styles.backdrop} 
            activeOpacity={1} 
            onPress={closeSidebarMobile}
          />
        )}

        {/* Sidebar (Rendered after KeyboardAvoidingView so it overlays) */}
        <Animated.View style={[
          isDesktop ? styles.sidebarDesktop : styles.sidebarMobile,
          {
            width: sidebarWidth,
            transform: !isDesktop ? [{
              translateX: sidebarAnim.interpolate({
                inputRange: [0, 1],
                outputRange: [-sidebarWidth, 0]
              })
            }] : [],
            marginLeft: isDesktop ? sidebarAnim.interpolate({
              inputRange: [0, 1],
              outputRange: [-sidebarWidth, 0]
            }) : 0
          }
        ]}>
          <SafeAreaView style={{flex: 1}} edges={['top', 'bottom']}>
            <View style={styles.sidebarContent}>
              <View style={styles.sidebarHeader}>
                <View style={styles.searchContainer}>
                  <Ionicons name="search" size={16} color="#9ca3af" style={styles.searchIcon} />
                  <TextInput
                    style={styles.searchInput}
                    placeholder="Search chats"
                    placeholderTextColor="#9ca3af"
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                  />
                </View>
                <TouchableOpacity style={styles.newChatButton} onPress={handleNewChat}>
                  <View style={styles.newChatIconBg}>
                    <Ionicons name="add" size={18} color="#1c1c1c" />
                  </View>
                  <Text style={styles.newChatText}>New Chat</Text>
                </TouchableOpacity>
              </View>
              
              <Text style={styles.historyHeader}>Recents</Text>
              <ScrollView style={styles.historyList}>
                {sessions.length === 0 ? (
                  <Text style={styles.emptyHistoryText}>No previous sessions</Text>
                ) : (
                  sessions.filter(s => {
                    const displayTitle = s.title.startsWith('I am at ') ? 'Local traffic rules' : s.title;
                    return displayTitle.toLowerCase().includes(searchQuery.toLowerCase());
                  }).map(s => {
                    const displayTitle = s.title.startsWith('I am at ') ? 'Local traffic rules' : s.title;
                    return (
                      <TouchableOpacity key={s.id} style={[styles.historyItem, activeSessionId === s.id && styles.historyItemActive]} onPress={() => handleLoadSession(s)}>
                        <Text style={[styles.historyItemText, activeSessionId === s.id && { color: "#1c1c1c", fontWeight: "600" }]} numberOfLines={1}>{displayTitle}</Text>
                      </TouchableOpacity>
                    );
                  })
                )}
              </ScrollView>

              {/* User Profile Area */}
              <View style={styles.sidebarFooter}>
                <View style={styles.userAvatar}>
                  <Text style={styles.userAvatarText}>{profile.avatar || 'D'}</Text>
                </View>
                <View style={styles.userInfo}>
                  <Text style={styles.userName}>{profile.name}</Text>
                </View>
                <TouchableOpacity onPress={() => router.push('/(tabs)/settings')}>
                  <Ionicons name="settings-outline" size={20} color="#4b5563" />
                </TouchableOpacity>
              </View>
            </View>
          </SafeAreaView>
        </Animated.View>

      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#FAF8F5',
  },
  mainLayout: {
    flex: 1,
    flexDirection: 'row-reverse',
    overflow: 'hidden',
  },
  sidebarDesktop: {
    height: '100%',
    backgroundColor: '#f3f0ea',
    borderRightWidth: 1,
    borderRightColor: '#e5e7eb',
  },
  sidebarMobile: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: '#f3f0ea',
    zIndex: 50,
    elevation: 50,
    shadowColor: '#000',
    shadowOffset: { width: 2, height: 0 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
  },
  backdrop: {
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
    zIndex: 40,
    elevation: 40,
  },
  sidebarContent: {
    flex: 1,
    padding: 16,
  },
  sidebarHeader: {
    marginBottom: 16,
    marginTop: 4,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#e5e7eb',
    borderRadius: 8,
    paddingHorizontal: 12,
    height: 36,
    marginBottom: 12,
  },
  searchIcon: {
    marginRight: 6,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: '#1c1c1c',
  },
  newChatButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 8,
  },
  newChatIconBg: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#e5e7eb',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  newChatText: {
    color: '#1c1c1c',
    fontWeight: '500',
    fontSize: 15,
  },
  historyHeader: {
    fontSize: 13,
    fontWeight: '500',
    color: '#6b7280',
    marginBottom: 8,
    paddingHorizontal: 8,
  },
  historyList: {
    flex: 1,
  },
  historyItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 6,
    marginBottom: 2,
  },
  historyItemActive: {
    backgroundColor: '#e5e7eb',
  },
  historyItemText: {
    fontSize: 14,
    color: '#4b5563',
    flex: 1,
  },
  sidebarFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    marginTop: 'auto',
  },
  userAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#d97706',
    justifyContent: 'center',
    alignItems: 'center',
  },
  userAvatarText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 16,
  },
  userInfo: {
    flex: 1,
    marginLeft: 12,
  },
  userName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1c1c1c',
  },
  userSubtitle: {
    fontSize: 12,
    color: '#6b7280',
  },
  emptyHistoryText: {
    fontSize: 14,
    color: '#9ca3af',
    fontStyle: 'italic',
    textAlign: 'center',
    marginTop: 20,
  },
  container: {
    flex: 1,
    backgroundColor: '#FAF8F5',
  },
  trustBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#fffbeb',
    borderBottomWidth: 1,
    borderBottomColor: '#fde68a',
  },
  trustBannerText: {
    flex: 1,
    fontSize: 11,
    color: '#92400e',
    fontWeight: '500',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f0ea',
    backgroundColor: '#fff',
  },
  backButton: {
    padding: 4,
  },
  headerTitleContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 12,
  },
  assistantIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#d97706',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#1c1c1c',
  },
  translateButton: {
    padding: 4,
  },
  chatArea: {
    flex: 1,
  },
  chatContent: {
    padding: 16,
    paddingBottom: 32,
  },
  dateDivider: {
    textAlign: 'center',
    fontSize: 11,
    fontWeight: '700',
    color: '#9ca3af',
    textTransform: 'uppercase',
    marginBottom: 24,
    backgroundColor: '#f3f0ea',
    alignSelf: 'center',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },
  messageWrapper: {
    flexDirection: 'row',
    marginBottom: 24,
    maxWidth: '85%',
  },
  userWrapper: {
    alignSelf: 'flex-end',
    flexDirection: 'row-reverse',
  },
  aiWrapper: {
    alignSelf: 'flex-start',
  },
  aiAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#fef3c7',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
  },
  bubbleContainer: {
    flex: 1,
  },
  sourceTag: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
    backgroundColor: '#fef3c7',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    alignSelf: 'flex-start',
  },
  sourceTagText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#b45309',
    marginLeft: 4,
  },
  messageBubble: {
    padding: 14,
    borderRadius: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  aiBubble: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 4,
  },
  userBubble: {
    backgroundColor: '#1c1c1c',
    borderTopRightRadius: 4,
  },
  messageText: {
    fontSize: 15,
    lineHeight: 22,
  },
  aiText: {
    color: '#1c1c1c',
  },
  userText: {
    color: '#fff',
  },
  sourceFooter: {
    fontSize: 10,
    fontStyle: 'italic',
    color: '#9ca3af',
    marginTop: 6,
    marginLeft: 4,
  },
  suggestionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 12,
    gap: 8,
  },
  suggestionChip: {
    backgroundColor: '#fff',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  suggestionText: {
    fontSize: 13,
    color: '#4b5563',
    fontWeight: '500',
  },
  loadingWrapper: {
    padding: 10,
    alignSelf: 'flex-start',
    marginLeft: 36,
  },
  attachMenu: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    position: 'absolute',
    bottom: 80,
    left: 0,
    right: 0,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
    elevation: 10,
    zIndex: 100,
  },
  attachRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  attachItem: {
    alignItems: 'center',
    gap: 8,
  },
  attachIcon: {
    width: 50,
    height: 50,
    borderRadius: 25,
    justifyContent: 'center',
    alignItems: 'center',
  },
  attachLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#4b5563',
  },
  inputContainer: {
    padding: 16,
    backgroundColor: '#FAF8F5',
    borderTopWidth: 1,
    borderTopColor: '#f3f0ea',
    position: Platform.OS === 'web' ? 'sticky' as any : 'relative',
    bottom: 0,
    zIndex: 10,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 30,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#f3f0ea',
  },
  attachButton: {
    padding: 4,
  },
  input: {
    flex: 1,
    paddingHorizontal: 12,
    fontSize: 15,
    color: '#1c1c1c',
    maxHeight: 100,
  },
  micButton: {
    padding: 4,
    marginRight: 4,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#d97706',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendButtonDisabled: {
    backgroundColor: '#f3f0ea',
  }
});

