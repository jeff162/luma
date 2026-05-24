// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { Link, useLocation } from 'react-router-dom'

/*
 * Cross-link between help topics that forwards the original "Back to <page>"
 * source so it survives multiple hops within the Help section. Plain
 * <Link to="/help/..."> from inside one topic to another would lose the source
 * path stamped by the originating FeatureExplainer popover and the back
 * affordance would disappear after the first hop. Use this for any internal
 * link added inside a topic body in content.jsx.
 */
export default function HelpLink({ to, children, ...rest }) {
  const location = useLocation()
  const from = location.state?.from
  return (
    <Link to={to} state={from ? { from } : undefined} {...rest}>
      {children}
    </Link>
  )
}
