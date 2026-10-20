import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { WebView } from 'react-native-webview';

const WEBSITE_URL =
  'https://logi-theta.vercel.app/#system-backup-panel';

export default function HomeScreen() {
  const webViewRef = useRef<WebView>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!canGoBack) {
        return false;
      }

      webViewRef.current?.goBack();
      return true;
    });

    return () => subscription.remove();
  }, [canGoBack]);

  function retryLoading() {
    setLoadError(null);
    setHasLoaded(false);
    setIsLoading(true);
    setReloadKey((key) => key + 1);
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <StatusBar style="dark" />
      <WebView
        key={reloadKey}
        ref={webViewRef}
        source={{ uri: WEBSITE_URL }}
        style={styles.webView}
        pullToRefreshEnabled
        allowsBackForwardNavigationGestures
        onLoadStart={() => {
          setIsLoading(true);
          setLoadError(null);
        }}
        onLoadEnd={() => {
          setIsLoading(false);
          setHasLoaded(true);
        }}
        onError={(event) => {
          setLoadError(event.nativeEvent.description || 'Check your internet connection and try again.');
          setIsLoading(false);
          setHasLoaded(true);
        }}
        onNavigationStateChange={(navigationState) => setCanGoBack(navigationState.canGoBack)}
      />

      {isLoading && !hasLoaded && !loadError && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#2563eb" />
          <Text style={styles.loadingText}>Loading Logi...</Text>
        </View>
      )}

      {loadError && (
        <View style={styles.errorOverlay}>
          <Text style={styles.errorTitle}>Logi couldn’t load</Text>
          <Text style={styles.errorMessage}>{loadError}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={retryLoading}
            style={({ pressed }) => [styles.retryButton, pressed && styles.retryButtonPressed]}>
            <Text style={styles.retryButtonText}>Try again</Text>
          </Pressable>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  webView: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: '#ffffff',
  },
  loadingText: {
    color: '#334155',
    fontSize: 16,
  },
  errorOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
    backgroundColor: '#ffffff',
  },
  errorTitle: {
    color: '#0f172a',
    fontSize: 20,
    fontWeight: '600',
  },
  errorMessage: {
    color: '#475569',
    fontSize: 15,
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 8,
    borderRadius: 8,
    backgroundColor: '#2563eb',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  retryButtonPressed: {
    opacity: 0.8,
  },
  retryButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
});
