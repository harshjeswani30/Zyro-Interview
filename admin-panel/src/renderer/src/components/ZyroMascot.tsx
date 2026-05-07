import React from 'react'
import '../assets/mascot.css'

interface ZyroMascotProps {
  size?: number | string
  className?: string
  headColor?: string
  strokeColor?: string
}

const ZyroMascot: React.FC<ZyroMascotProps> = ({
  size = 40,
  className = '',
  headColor = 'transparent',
  strokeColor = 'currentColor'
}) => {
  return (
    <div
      className={`mascot-container-inner ${className}`}
      style={{ width: size, height: size }}
    >
      <svg
        className="mascot-svg"
        viewBox="0 0 400 400"
        xmlns="http://www.w3.org/2000/svg"
        style={{ color: strokeColor }}
      >
        <g className="mascot-group-anim">
          {/* Head Base */}
          <g className="mascot-head-base">
            <circle
              cx="200"
              cy="200"
              r="140"
              style={{ fill: headColor, stroke: 'currentColor' }}
              className="mascot-stroke-main"
            />

            {/* State: Happy */}
            <g className="state-happy" style={{ stroke: 'currentColor' }}>
              <path
                d="M 140 170 Q 160 140 180 170"
                className="mascot-stroke-main"
                strokeLinecap="round"
              />
              <path
                d="M 220 170 Q 240 140 260 170"
                className="mascot-stroke-main"
                strokeLinecap="round"
              />
              <path
                d="M 150 230 Q 200 280 250 230"
                className="mascot-stroke-main"
                strokeLinecap="round"
              />
              <path
                d="M 140 220 L 150 230 M 260 220 L 250 230"
                className="mascot-stroke-main"
                strokeLinecap="round"
              />
            </g>

            {/* State: Search */}
            <g className="state-search" style={{ stroke: 'currentColor' }}>
              <line
                x1="140"
                y1="170"
                x2="180"
                y2="170"
                className="mascot-stroke-main"
                strokeLinecap="round"
              />
              <line
                x1="220"
                y1="170"
                x2="260"
                y2="170"
                className="mascot-stroke-main"
                strokeLinecap="round"
              />
              <path
                d="M 180 240 Q 200 245 220 240"
                className="mascot-stroke-main"
                strokeLinecap="round"
              />
            </g>

            {/* State: Found */}
            <g className="state-found">
              <circle cx="160" cy="165" r="16" style={{ fill: 'currentColor' }} />
              <circle cx="240" cy="165" r="16" style={{ fill: 'currentColor' }} />
              <ellipse cx="200" cy="250" rx="20" ry="30" style={{ fill: 'currentColor' }} />
            </g>

            {/* State: Cool */}
            <g className="state-cool" style={{ stroke: 'currentColor' }}>
              <path
                d="M 160 250 L 230 230"
                className="mascot-stroke-main"
                strokeLinecap="round"
              />
              <path
                d="M 230 230 L 240 235"
                className="mascot-stroke-main"
                strokeLinecap="round"
              />
            </g>
          </g>

          {/* Prop: Burst */}
          <g
            className="prop-burst"
            style={{ stroke: 'currentColor' }}
            strokeLinecap="round"
            strokeWidth="8"
          >
            <line x1="200" y1="10" x2="200" y2="40" />
            <line x1="330" y1="70" x2="310" y2="90" />
            <line x1="70" y1="70" x2="90" y2="90" />
          </g>

          {/* Prop: Magnifying Glass */}
          <g className="prop-mag">
            <circle
              cx="160"
              cy="170"
              r="50"
              style={{ fill: headColor, stroke: 'currentColor' }}
              className="mascot-stroke-main"
              strokeWidth="8"
            />
            <path
              d="M 130 140 A 35 35 0 0 1 180 140"
              stroke="white"
              strokeWidth="6"
              fill="none"
              strokeLinecap="round"
            />
            <line
              x1="195"
              y1="205"
              x2="260"
              y2="270"
              style={{ stroke: 'currentColor' }}
              strokeWidth="16"
              strokeLinecap="round"
            />
            <circle cx="195" cy="205" r="10" style={{ fill: 'currentColor' }} />
          </g>

          {/* Prop: Glasses */}
          <g className="prop-glasses">
            <path
              d="M 120 160 L 190 160 Q 190 200 155 200 Q 120 200 120 160 Z"
              style={{ fill: 'currentColor' }}
            />
            <path
              d="M 210 160 L 280 160 Q 280 200 245 200 Q 210 200 210 160 Z"
              style={{ fill: 'currentColor' }}
            />
            <line
              x1="185"
              y1="165"
              x2="215"
              y2="165"
              style={{ stroke: 'currentColor' }}
              className="mascot-stroke-main"
              strokeWidth="6"
            />
            <line
              x1="120"
              y1="165"
              x2="90"
              y2="150"
              style={{ stroke: 'currentColor' }}
              className="mascot-stroke-main"
              strokeWidth="8"
              strokeLinecap="round"
            />
            <line
              x1="280" y1="165" x2="310" y2="150"
              style={{ stroke: 'currentColor' }}
              className="mascot-stroke-main"
              strokeWidth="8"
              strokeLinecap="round"
            />
            <line
              x1="130" y1="165" x2="150" y2="165"
              stroke="white"
              strokeWidth="4"
              strokeLinecap="round"
            />
            <line
              x1="220" y1="165" x2="240" y2="165"
              stroke="white"
              strokeWidth="4"
              strokeLinecap="round"
            />
          </g>
        </g>
      </svg>
    </div>
  )
}

export default ZyroMascot
