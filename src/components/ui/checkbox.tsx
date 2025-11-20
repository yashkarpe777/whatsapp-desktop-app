import * as React from "react";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

const Checkbox = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { onCheckedChange?: (checked: boolean) => void }
>(({ className, onCheckedChange, ...props }, ref) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    props.onChange?.(e);
    onCheckedChange?.(e.target.checked);
  };

  return (
    <div className="relative">
      <input
        type="checkbox"
        ref={ref}
        className={cn(
          "appearance-none bg-transparent border border-primary rounded-sm h-4 w-4 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:opacity-50",
          props.checked && "bg-primary",
          className
        )}
        onChange={handleChange}
        {...props}
      />
      {props.checked && (
        <Check className="absolute inset-0 flex items-center justify-center h-4 w-4 text-primary-foreground pointer-events-none z-10" />
      )}
    </div>
  );
});
Checkbox.displayName = "Checkbox";

export { Checkbox };
