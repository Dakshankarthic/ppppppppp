import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface MarkdownRendererProps {
  content: string;
  isAI?: boolean;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content, isAI = true }) => {
  const parseBlocks = (rawText: string) => {
    // Split by blockquotes starting with > [!
    const regex = /(?=>\s*\[!(?:NOTE|WARNING|IMPORTANT|TIP|CAUTION)\])/g;
    const blocks = rawText.split(regex);
    
    return blocks.map((block, idx) => {
      const alertMatch = block.match(/^>\s*\[!(NOTE|WARNING|IMPORTANT|TIP|CAUTION)\]\s*([\s\S]*)/);
      if (alertMatch) {
        const type = alertMatch[1];
        const alertContent = alertMatch[2].replace(/^>\s?/gm, '').trim();
        
        let bgColor = '#fef3c7';
        let iconColor = '#d97706';
        let iconName = 'information-circle';
        
        if (type === 'WARNING' || type === 'CAUTION') {
          bgColor = '#fee2e2';
          iconColor = '#ef4444';
          iconName = 'warning';
        } else if (type === 'IMPORTANT') {
          bgColor = '#e0e7ff';
          iconColor = '#4f46e5';
          iconName = 'alert-circle';
        } else if (type === 'TIP') {
          bgColor = '#dcfce7';
          iconColor = '#16a34a';
          iconName = 'bulb';
        }
        
        return (
          <View key={`block-${idx}`} style={[styles.alertBox, { backgroundColor: bgColor, borderLeftColor: iconColor }]}>
            <Ionicons name={iconName as any} size={20} color={iconColor} style={styles.alertIcon} />
            <View style={styles.alertContentContainer}>
              <Text style={[styles.alertTitle, { color: iconColor }]}>{type}</Text>
              {renderParagraphs(alertContent, isAI, true)}
            </View>
          </View>
        );
      }
      
      return (
        <View key={`block-${idx}`}>
          {renderParagraphs(block, isAI)}
        </View>
      );
    });
  };

  const renderParagraphs = (text: string, isAI: boolean, inAlert = false) => {
    const paragraphs = text.split(/\n\n+/);
    return paragraphs.map((p, idx) => {
      const isListItem = /^\s*([-*•]|\d+\.)\s+/.test(p);
      
      if (isListItem) {
        const items = p.split(/\n/);
        return (
          <View key={`p-${idx}`} style={styles.listContainer}>
            {items.map((item, i) => {
              const match = item.match(/^(\s*)([-*•]|\d+\.)\s+/);
              const indent = match ? match[1].length * 8 : 0;
              const cleanItem = match ? item.substring(match[0].length) : item;
              
              if (!item.trim()) return null;
              return (
                <View key={`li-${i}`} style={[styles.listItem, { marginLeft: indent }]}>
                  {match ? (
                    <Text style={[styles.bullet, { color: isAI ? '#1c1c1c' : '#fff' }]}>•</Text>
                  ) : (
                    <Text style={[styles.bullet, { color: 'transparent' }]}>•</Text>
                  )}
                  <Text style={[
                    styles.text, 
                    isAI ? styles.aiText : styles.userText,
                    inAlert && styles.alertText,
                    { flex: 1 }
                  ]}>
                    {renderInline(cleanItem, isAI, inAlert)}
                  </Text>
                </View>
              );
            })}
          </View>
        );
      }
      
      return (
        <Text key={`p-${idx}`} style={[
          styles.text, 
          isAI ? styles.aiText : styles.userText,
          idx > 0 && styles.paragraphMargin,
          inAlert && styles.alertText
        ]}>
          {renderInline(p, isAI, inAlert)}
        </Text>
      );
    });
  };

  const renderInline = (text: string, isAI: boolean, inAlert = false) => {
    // Regex to match **bold**, *italic*, and `code`
    const regex = /(\*\*.*?\*\*|\*.*?\*|`.*?`)/g;
    const parts = text.split(regex);
    
    return parts.map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return (
          <Text key={i} style={[styles.bold, isAI ? styles.aiText : styles.userText, inAlert && styles.alertText]}>
            {part.slice(2, -2)}
          </Text>
        );
      }
      if (part.startsWith('*') && part.endsWith('*')) {
        return (
          <Text key={i} style={[styles.italic, isAI ? styles.aiText : styles.userText, inAlert && styles.alertText]}>
            {part.slice(1, -1)}
          </Text>
        );
      }
      if (part.startsWith('`') && part.endsWith('`')) {
        return (
          <Text key={i} style={styles.code}>
            {part.slice(1, -1)}
          </Text>
        );
      }
      return part;
    });
  };

  return <View style={styles.container}>{parseBlocks(content)}</View>;
};

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  alertBox: {
    padding: 12,
    borderRadius: 8,
    marginTop: 8,
    marginBottom: 8,
    borderLeftWidth: 4,
    flexDirection: 'row',
  },
  alertIcon: {
    marginRight: 8,
    marginTop: 2,
  },
  alertContentContainer: {
    flex: 1,
  },
  alertTitle: {
    fontWeight: 'bold',
    fontSize: 12,
    marginBottom: 4,
  },
  text: {
    fontSize: 15,
    lineHeight: 22,
  },
  aiText: {
    color: '#1c1c1c',
  },
  userText: {
    color: '#fff',
  },
  alertText: {
    color: '#1c1c1c',
    fontSize: 14,
  },
  bold: {
    fontWeight: 'bold',
  },
  italic: {
    fontStyle: 'italic',
  },
  code: {
    fontFamily: 'monospace',
    backgroundColor: 'rgba(0,0,0,0.05)',
    paddingHorizontal: 4,
    borderRadius: 4,
    fontSize: 13,
  },
  paragraphMargin: {
    marginTop: 8,
  },
  listContainer: {
    marginTop: 8,
    marginBottom: 8,
  },
  listItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 4,
    paddingLeft: 4,
  },
  bullet: {
    marginRight: 8,
    fontSize: 15,
    lineHeight: 22,
  }
});
