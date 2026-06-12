'use client';
// app/components/DecryptedText.tsx — ported from ArxivExplorer/SeekYou

import { useState } from 'react';
import { motion } from 'framer-motion';
import { useTextScramble } from '@/lib/hooks';

interface DecryptedTextProps {
  text: string;
  speed?: number;
  maxIterations?: number;
  useOriginalCharsOnly?: boolean;
  characters?: string;
  className?: string;
  parentClassName?: string;
  encryptedClassName?: string;
  animateOn?: 'view' | 'hover';
}

export default function DecryptedText({
  text,
  speed = 50,
  maxIterations = 10,
  useOriginalCharsOnly = false,
  characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890!@#$%^&*()_+-=[]{}|;:,.<>?',
  className = '',
  parentClassName = '',
  encryptedClassName = 'text-neon-red/40',
  animateOn = 'hover',
}: DecryptedTextProps) {
  const [isHovering, setIsHovering] = useState(false);
  const { displayText, scramble } = useTextScramble(text, {
    speed, maxIterations, useOriginalCharsOnly, characters, animateOn,
  });

  return (
    <motion.span
      className={`inline-block whitespace-nowrap ${parentClassName}`}
      onMouseEnter={() => { if (animateOn === 'hover') { setIsHovering(true); scramble(); } }}
      onMouseLeave={() => { if (animateOn === 'hover') setIsHovering(false); }}
    >
      <span className={className}>
        {displayText.split('').map((char, index) => {
          const isOriginal = char === text[index];
          return (
            <span key={index} className={isOriginal ? undefined : encryptedClassName}>
              {char}
            </span>
          );
        })}
      </span>
    </motion.span>
  );
}
