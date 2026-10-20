import { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const WEBSITE_URL =
  'https://logi-theta.vercel.app/#system-backup-panel';

export default function HomeScreen() {
  const [openError, setOpenError] = useState<string | null>(null);

  async function openWebsite() {
    try {
      await Linking.openURL(WEBSITE_URL);
      setOpenError(null);
    } catch {
      setOpenError('Unable to open Logi. Please try again.');
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>Logi</Text>
        <Text style={styles.message}>
          Open the Logi website in your browser. The in-app website view is available on iOS and
          Android.
        </Text>
        <Pressable
          accessibilityRole="link"
          onPress={openWebsite}
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}>
          <Text style={styles.buttonText}>Open Logi</Text>
        </Pressable>
        {openError && <Text style={styles.error}>{openError}</Text>}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    backgroundColor: '#ffffff',
  },
  content: {
    alignItems: 'center',
    gap: 16,
    padding: 24,
  },
  title: {
    color: '#0f172a',
    fontSize: 28,
    fontWeight: '700',
  },
  message: {
    color: '#475569',
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
  },
  button: {
    borderRadius: 8,
    backgroundColor: '#2563eb',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  buttonPressed: {
    opacity: 0.8,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  error: {
    color: '#b91c1c',
    textAlign: 'center',
  },
});
