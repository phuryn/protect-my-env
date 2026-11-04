export interface EnvLine {
  lineIndex: number;
  originalText: string;
  /** 'continuation': a physical line that belongs to the multiline value of the pair above it. */
  type: 'empty' | 'comment' | 'pair' | 'continuation';
  key?: string;
  value?: string;
  valueStartOffset?: number;
  valueEndOffset?: number;
  commentStartOffset?: number;
  commentEndOffset?: number;
}

export class EnvParser {
  /**
   * Parses an entire .env document text into structured lines.
   */
  public static parse(text: string): EnvLine[] {
    const lines = text.split(/\r?\n/);
    const breaks = text.match(/\r?\n/g) ?? [];
    const result: EnvLine[] = [];

    let index = 0;
    while (index < lines.length) {
      const parsed = this.parseLine(lines[index], index);
      const multiline = parsed.type === 'pair'
        ? this.joinMultilineValue(parsed, lines, breaks)
        : undefined;

      if (multiline) {
        result.push(multiline.pair);
        for (let next = index + 1; next <= multiline.lastLine; next++) {
          result.push({ lineIndex: next, originalText: lines[next], type: 'continuation' });
        }
        index = multiline.lastLine + 1;
        continue;
      }

      result.push(parsed);
      index++;
    }

    return result;
  }

  /**
   * A quoted value whose closing quote is on a later line (PEM keys, certificates) is one
   * value, as dotenv reads it. Returns the pair re-spanned across those lines, with offsets
   * still relative to the start of its first line, or undefined when the quote closes on
   * its own line or never closes.
   */
  private static joinMultilineValue(
    pair: EnvLine,
    lines: string[],
    breaks: string[]
  ): { pair: EnvLine; lastLine: number } | undefined {
    const value = pair.value ?? '';
    const quote = value[0];
    if ((quote !== '"' && quote !== "'") || this.findClosingQuote(value, 1, quote) !== -1) {
      return undefined;
    }

    let fullText = lines[pair.lineIndex];
    for (let next = pair.lineIndex + 1; next < lines.length; next++) {
      const line = lines[next];
      const lineStart = fullText.length + breaks[next - 1].length;
      fullText += breaks[next - 1] + line;

      const close = this.findClosingQuote(line, 0, quote);
      if (close === -1) {
        continue;
      }

      const valueEndOffset = lineStart + close + 1;
      const commentMatch = line.substring(close + 1).match(/\s#/);
      const commentStartOffset = commentMatch && commentMatch.index !== undefined
        ? valueEndOffset + commentMatch.index + 1
        : undefined;

      return {
        lastLine: next,
        pair: {
          ...pair,
          originalText: fullText,
          value: fullText.substring(pair.valueStartOffset ?? 0, valueEndOffset),
          valueEndOffset,
          commentStartOffset,
          commentEndOffset: commentStartOffset !== undefined ? fullText.length : undefined,
        },
      };
    }

    return undefined;
  }

  private static findClosingQuote(text: string, from: number, quote: string): number {
    let escaped = false;
    for (let i = from; i < text.length; i++) {
      const char = text[i];
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Parses a single line from a .env file.
   */
  public static parseLine(lineText: string, lineIndex: number): EnvLine {
    const trimmed = lineText.trim();

    // Check for empty line
    if (trimmed.length === 0) {
      return {
        lineIndex,
        originalText: lineText,
        type: 'empty',
      };
    }

    // Check for full line comment
    if (trimmed.startsWith('#')) {
      const commentIdx = lineText.indexOf('#');
      return {
        lineIndex,
        originalText: lineText,
        type: 'comment',
        commentStartOffset: commentIdx !== -1 ? commentIdx : 0,
        commentEndOffset: lineText.length,
      };
    }

    // Find the first assignment equals sign
    const equalIndex = lineText.indexOf('=');
    if (equalIndex === -1) {
      // Treat invalid syntax lines as comments to avoid decorating them
      const hashIdx = lineText.indexOf('#');
      return {
        lineIndex,
        originalText: lineText,
        type: 'comment',
        commentStartOffset: hashIdx !== -1 ? hashIdx : undefined,
        commentEndOffset: hashIdx !== -1 ? lineText.length : undefined,
      };
    }

    const keyPart = lineText.substring(0, equalIndex);
    const valuePart = lineText.substring(equalIndex + 1);

    // Validate the key format (must look like a variable name)
    // `export KEY=value` (shell-style) is a pair too; without this it renders as a plain-text comment.
    const keyMatch = keyPart.match(/^\s*(?:export\s+)?([A-Za-z0-9_.-]+)\s*$/);
    if (!keyMatch) {
      const hashIdx = lineText.indexOf('#');
      return {
        lineIndex,
        originalText: lineText,
        type: 'comment',
        commentStartOffset: hashIdx !== -1 ? hashIdx : undefined,
        commentEndOffset: hashIdx !== -1 ? lineText.length : undefined,
      };
    }

    const key = keyMatch[1];

    // Find the start of the value, skipping leading spaces
    let valStart = 0;
    while (valStart < valuePart.length && /\s/.test(valuePart[valStart])) {
      valStart++;
    }

    const absoluteStart = equalIndex + 1 + valStart;
    let absoluteEnd = absoluteStart;
    let commentStart: number | undefined;

    if (valStart < valuePart.length) {
      const firstChar = valuePart[valStart];

      if (firstChar === '"' || firstChar === "'") {
        // Quoted value: find the matching closing quote, respecting backslash escapes
        let valEnd = valStart + 1;
        let escaped = false;
        let foundClosing = false;

        while (valEnd < valuePart.length) {
          const char = valuePart[valEnd];
          if (escaped) {
            escaped = false;
          } else if (char === '\\') {
            escaped = true;
          } else if (char === firstChar) {
            foundClosing = true;
            break;
          }
          valEnd++;
        }

        if (foundClosing) {
          absoluteEnd = equalIndex + 1 + valEnd + 1;
          
          // Check for inline comment after the quoted value
          const remainder = valuePart.substring(valEnd + 1);
          const commentMatch = remainder.match(/\s#/);
          if (commentMatch && commentMatch.index !== undefined) {
            commentStart = equalIndex + 1 + (valEnd + 1) + commentMatch.index + 1;
          }
        } else {
          // If no closing quote, consume the rest of the line (except trailing space)
          let endIdx = valuePart.length;
          while (endIdx > valStart && /\s/.test(valuePart[endIdx - 1])) {
            endIdx--;
          }
          absoluteEnd = equalIndex + 1 + endIdx;
        }
      } else {
        // Unquoted value: search for an inline comment (space followed by #)
        const commentMatch = valuePart.substring(valStart).match(/\s#/);
        let valEndOffset = valuePart.length;

        if (commentMatch && commentMatch.index !== undefined) {
          valEndOffset = valStart + commentMatch.index;
          commentStart = equalIndex + 1 + valStart + commentMatch.index + 1;
        }

        // Trim trailing space from the value
        while (valEndOffset > valStart && /\s/.test(valuePart[valEndOffset - 1])) {
          valEndOffset--;
        }

        absoluteEnd = equalIndex + 1 + valEndOffset;
      }
    }

    const value = lineText.substring(absoluteStart, absoluteEnd);

    return {
      lineIndex,
      originalText: lineText,
      type: 'pair',
      key,
      value,
      valueStartOffset: absoluteStart,
      valueEndOffset: absoluteEnd,
      commentStartOffset: commentStart,
      commentEndOffset: commentStart !== undefined ? lineText.length : undefined,
    };
  }
}
