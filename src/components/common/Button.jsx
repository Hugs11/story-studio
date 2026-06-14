import { forwardRef } from 'react';

/**
 * Bouton d'UI unifié — fin wrapper autour de `<button>` qui mappe `variant`/`size`
 * vers le système de classes `.btn` de `layout.css` (source unique des états
 * hover/focus/active/disabled). Spread des props natives + `className` composable.
 *
 *   variant : 'secondary' (défaut) | 'primary' | 'secondary-violet' | 'ghost'
 *             | 'danger' | 'danger-outline' | 'icon'
 *   size    : 'md' (défaut) | 'sm'
 */
const VARIANT_CLASS = {
  primary: 'btn-primary',
  secondary: '',
  'secondary-violet': 'btn-secondary-violet',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
  'danger-outline': 'btn-danger-outline',
};

export function buttonClassName({ variant = 'secondary', size = 'md', className = '' } = {}) {
  const classes = [];
  if (variant === 'icon') {
    classes.push('btn', 'btn-icon');
    if (size === 'sm') classes.push('btn-icon-sm');
  } else {
    classes.push(size === 'sm' ? 'btn-xs' : 'btn');
    const variantClass = VARIANT_CLASS[variant];
    if (variantClass) classes.push(variantClass);
  }
  if (className) classes.push(className);
  return classes.join(' ');
}

export const Button = forwardRef(function Button(
  { variant = 'secondary', size = 'md', className = '', type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClassName({ variant, size, className })}
      {...props}
    />
  );
});
